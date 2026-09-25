import express from "express";
import jwt from "jsonwebtoken";

import { comparePassword } from "../utils/password.js";
import { authenticateAdmin } from "../middleware/auth.js";
import { createLoginRateLimiter } from "../middleware/loginRateLimiter.js";

// The only status that may sign in or use admin endpoints. admins.status is a
// plain string (default "ACTIVE"); any other value counts as not active.
export const ACTIVE_ADMIN_STATUS = "ACTIVE";

const INVALID_LOGIN = { message: "Invalid email or password" };
const INVALID_TOKEN = { message: "Invalid or Expired Token" };

// Loaded lazily so tests can pass a fake client without touching the DB.
async function resolveDb(db) {
  return db ?? (await import("../config/prisma.js")).default;
}

// loginLimiter can be replaced in tests; each router gets its own counts.
export function createAuthRouter({ db, loginLimiter = createLoginRateLimiter() } = {}) {
  const router = express.Router();

  // Admin login. Rate limited here only, not on /me or other routes.
  router.post("/login", loginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({
          message: "Email and password are required",
        });
      }

      const client = await resolveDb(db);
      const admin = await client.admin.findUnique({
        where: { email },
      });

      // Same message for unknown email and wrong password, so emails can't be probed.
      if (!admin || !admin.passwordHash) {
        return res.status(401).json(INVALID_LOGIN);
      }

      // The password is checked for inactive accounts too, and both failures
      // get the same answer, so neither the response nor its timing reveals
      // that an account exists but is disabled.
      const passwordMatches = await comparePassword(
        password,
        admin.passwordHash
      );
      const isActive = admin.status === ACTIVE_ADMIN_STATUS;

      if (!passwordMatches || !isActive) {
        return res.status(401).json(INVALID_LOGIN);
      }

      const token = jwt.sign(
        {
          adminId: admin.adminId,
          email: admin.email,
          role: admin.role,
        },
        process.env.JWT_SECRET,
        {
          expiresIn: "1h",
        }
      );

      return res.status(200).json({
        message: "Login successful",
        token,
      });
    } catch (error) {
      console.error("Login error:", error);

      return res.status(500).json({
        message: "Internal server error",
      });
    }
  });

  // Current admin's profile, looked up from the token's adminId. The token
  // alone doesn't show a later deactivation, so the stored status is checked
  // here; future admin endpoints need the same check.
  router.get("/me", authenticateAdmin, async (req, res) => {
    try {
      const client = await resolveDb(db);
      const admin = await client.admin.findUnique({
        where: {
          adminId: req.admin.adminId,
        },
        select: {
          adminId: true,
          email: true,
          name: true,
          role: true,
          status: true,
        },
      });

      if (!admin) {
        return res.status(404).json({
          message: "Admin not found!",
        });
      }

      // Deactivated after the token was issued: treat the token as no longer
      // valid, without saying why.
      if (admin.status !== ACTIVE_ADMIN_STATUS) {
        return res.status(401).json(INVALID_TOKEN);
      }

      return res.status(200).json({
        message: "Admin profile successfully fetched",
        admin,
      });
    } catch (error) {
      console.error("Protected admin route error", error.message);

      return res.status(500).json({
        message: "Internal Server Error",
      });
    }
  });

  return router;
}

export default createAuthRouter();
