import express from "express";
import jwt from "jsonwebtoken";

import crypto from "crypto";

import { comparePassword, hashPassword } from "../utils/password.js";
import { authenticateAdmin, JWT_ALGORITHM } from "../middleware/auth.js";
import { createLoginRateLimiter } from "../middleware/loginRateLimiter.js";

// The only status that may sign in or use admin endpoints. admins.status is a
// plain string (default "ACTIVE"); any other value counts as not active.
export const ACTIVE_ADMIN_STATUS = "ACTIVE";

const INVALID_LOGIN = { message: "Invalid email or password" };
const INVALID_TOKEN = { message: "Invalid or Expired Token" };
const MISSING_CREDENTIALS = { message: "Email and password are required" };
const INVALID_LOGIN_REQUEST = { message: "Invalid login request" };

// RFC 5321 limit for an address. bcrypt only reads the first 72 bytes of a
// password; the cap just stops huge inputs from reaching it.
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PASSWORD_LENGTH = 128;

// Checks the shape of the login body without echoing any of it back.
function validateLoginBody(body) {
  const { email, password } = body ?? {};
  if (email === undefined || email === null || email === "" || password === undefined || password === null || password === "") {
    return MISSING_CREDENTIALS;
  }
  if (typeof email !== "string" || typeof password !== "string") {
    return INVALID_LOGIN_REQUEST;
  }
  if (email.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return INVALID_LOGIN_REQUEST;
  }
  return null;
}

// Unknown emails are compared against this hash, so they take as long as a
// wrong password for a real account (SEC-012). It is a hash of random bytes
// made once per process: no password can match it.
let dummyHashPromise;
function dummyPasswordHash() {
  dummyHashPromise ??= hashPassword(crypto.randomBytes(32).toString("hex"));
  return dummyHashPromise;
}

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
      const invalidRequest = validateLoginBody(req.body);
      if (invalidRequest) {
        return res.status(400).json(invalidRequest);
      }

      const { password } = req.body;
      // Stored lowercased by scripts/createAdmin.js, so any capitalisation works.
      const email = req.body.email.trim().toLowerCase();

      const client = await resolveDb(db);
      const admin = await client.admin.findUnique({
        where: { email },
      });

      // A bcrypt comparison runs for every login, including unknown emails
      // and inactive accounts, and every failure gets the same answer. So
      // neither the response nor its timing shows whether an email exists
      // or an account is disabled.
      const hasHash = Boolean(admin?.passwordHash);
      const passwordMatches = await comparePassword(
        password,
        hasHash ? admin.passwordHash : await dummyPasswordHash()
      );
      const isActive = admin?.status === ACTIVE_ADMIN_STATUS;

      if (!hasHash || !passwordMatches || !isActive) {
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
          algorithm: JWT_ALGORITHM,
          expiresIn: "1h",
        }
      );

      return res.status(200).json({
        message: "Login successful",
        token,
      });
    } catch (error) {
      // Error type only: a database error can quote the email that was tried.
      console.error("Login error:", { errorType: error?.name ?? "Error" });

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
      console.error("Protected admin route error:", { errorType: error?.name ?? "Error" });

      return res.status(500).json({
        message: "Internal Server Error",
      });
    }
  });

  return router;
}

export default createAuthRouter();
