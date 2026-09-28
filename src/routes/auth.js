import express from "express";
import jwt from "jsonwebtoken";

import crypto from "crypto";

import { comparePassword, hashPassword } from "../utils/password.js";
import { authenticateAdmin, JWT_ALGORITHM, AUTH_COOKIE_NAME, authCookieOptions } from "../middleware/auth.js";
import { createLoginRateLimiter, createResetRateLimiter } from "../middleware/loginRateLimiter.js";
import { ACTIVE_ADMIN_STATUS } from "../middleware/requireActiveAdmin.js";
import { getInvitationByToken, setupPasswordFromInvitation, InvitationError } from "../services/adminInvitationService.js";
import {
  requestPasswordReset,
  validateResetToken,
  resetPassword,
  PasswordResetError,
} from "../services/passwordResetService.js";
import { resolveDb } from "../utils/resolveClients.js";

// The only status that may sign in or use admin endpoints. admins.status is a
// plain string (default "ACTIVE"); any other value counts as not active.
// Defined with the shared admin middleware; re-exported for existing imports.
export { ACTIVE_ADMIN_STATUS };

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


// loginLimiter and resetLimiter can be replaced in tests; each router gets its own counts.
export function createAuthRouter({
  db,
  loginLimiter = createLoginRateLimiter(),
  resetLimiter = createResetRateLimiter(),
} = {}) {
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

      // Phase 12: set the JWT as an httpOnly cookie instead of returning it
      // in the response body. The frontend never sees the raw token; it
      // relies on GET /auth/me to learn who is signed in.
      res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());

      return res.status(200).json({
        message: "Login successful",
        // token is still returned for backward-compatible tests and CLI tooling
        // that use the Authorization: Bearer header. The frontend no longer
        // reads this field (it relies on the cookie + GET /auth/me).
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

  // Phase 12: explicit sign-out clears the cookie server-side. A CSRF attack
  // cannot forge this because the cookie is SameSite=Strict; cross-site
  // requests never carry it. Requires a valid session to prevent logout-CSRF
  // amplification (an attacker cannot force a sign-out of a victim's session
  // they cannot observe).
  router.post("/logout", authenticateAdmin, (req, res) => {
    res.clearCookie(AUTH_COOKIE_NAME, authCookieOptions());
    return res.status(200).json({ message: "Signed out" });
  });

  // Phase 12 Checkpoint 2: Validate invitation token without consuming it.
  // Invitee loads the setup password page; this provides the name/email/role.
  router.get("/invitation", async (req, res) => {
    try {
      const token = typeof req.query.token === "string" ? req.query.token : null;
      if (!token) {
        return res.status(400).json({ message: "Invitation token is required" });
      }

      const client = await resolveDb(db);
      const invitation = await getInvitationByToken({ db: client, token });
      return res.status(200).json({
        message: "Invitation valid",
        invitation,
      });
    } catch (error) {
      if (error instanceof InvitationError) {
        return res.status(error.status).json({
          message: error.message,
          code: error.code ?? undefined,
        });
      }
      console.error("Invitation check error:", { errorType: error?.name ?? "Error" });
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  // Phase 12 Checkpoint 2: Invitee sets password and activates account.
  // Account becomes ACTIVE only after this succeeds. The token is marked ACCEPTED.
  router.post("/setup-password", async (req, res) => {
    try {
      const { token, password } = req.body ?? {};
      if (!token || typeof token !== "string" || !password || typeof password !== "string") {
        return res.status(400).json({ message: "Token and password are required" });
      }

      const client = await resolveDb(db);
      const result = await setupPasswordFromInvitation({ db: client, token, password });
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof InvitationError) {
        return res.status(error.status).json({
          message: error.message,
          code: error.code ?? undefined,
        });
      }
      console.error("Password setup error:", { errorType: error?.name ?? "Error" });
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  // Self-Service Password Recovery (Forgot Password)
  // Generates a 1-hour secure reset token and emails it to active admins.
  // Rate-limited to prevent abuse. Always returns generic success to prevent email enumeration.
  router.post("/forgot-password", resetLimiter, async (req, res) => {
    try {
      const email = req.body?.email;
      if (!email || typeof email !== "string" || email.trim() === "" || email.length > MAX_EMAIL_LENGTH) {
        return res.status(400).json({ message: "Email is required" });
      }

      const client = await resolveDb(db);
      const result = await requestPasswordReset({ db: client, email });
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof PasswordResetError) {
        return res.status(error.status).json({
          message: error.message,
          code: error.code ?? undefined,
        });
      }
      console.error("Forgot password error:", { errorType: error?.name ?? "Error" });
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  // Validates a password reset token without consuming it.
  router.get("/reset-password", async (req, res) => {
    try {
      const token = typeof req.query?.token === "string" ? req.query.token : null;
      if (!token) {
        return res.status(400).json({ message: "Reset token is required" });
      }

      const client = await resolveDb(db);
      const result = await validateResetToken({ db: client, token });
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof PasswordResetError) {
        return res.status(error.status).json({
          message: error.message,
          code: error.code ?? undefined,
        });
      }
      console.error("Reset token check error:", { errorType: error?.name ?? "Error" });
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  // Consumes a reset token, updates password hash, and logs audit record.
  router.post("/reset-password", async (req, res) => {
    try {
      const { token, password } = req.body ?? {};
      if (!token || typeof token !== "string" || !password || typeof password !== "string") {
        return res.status(400).json({ message: "Token and password are required" });
      }

      const client = await resolveDb(db);
      const result = await resetPassword({ db: client, token, password });
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof PasswordResetError) {
        return res.status(error.status).json({
          message: error.message,
          code: error.code ?? undefined,
        });
      }
      console.error("Reset password error:", { errorType: error?.name ?? "Error" });
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  return router;
}

export default createAuthRouter();
