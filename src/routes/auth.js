import express from "express";

import { createApiRateLimiter } from "../middleware/apiRateLimiter.js";
import { createAuthenticateIdentity, createRequireActiveUser } from "../middleware/requireActiveUser.js";
import { completeInvitation, UserAccountError } from "../services/userAccountService.js";
import { resolveDb } from "../utils/resolveClients.js";

// Session endpoints. Sign-in, sign-out, password recovery and the invitation
// email itself are Supabase Auth's (the admin app calls it directly with the
// public anon key); the backend only answers "who is this Supabase session in
// the application?". Every request carries the Supabase access token as
// Authorization: Bearer; there is no application cookie or token.

// The profile the admin app gets: no Supabase identity, credential or token.
const toProfile = (user) => ({ userId: user.adminId, email: user.email, name: user.name, role: user.role, status: user.status });

// verifyAccessToken and apiLimiter can be replaced in tests.
export function createAuthRouter({ db, verifyAccessToken, apiLimiter = createApiRateLimiter() } = {}) {
    const router = express.Router();

    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });

    // The signed-in user's application profile. 401 without a valid Supabase
    // session; 403 when the session has no ACTIVE application user.
    router.get("/me", apiLimiter, createRequireActiveUser({ db, verifyAccessToken }), (req, res) => {
        res.json({ user: toProfile(req.user) });
    });

    // The invitee, signed in through their Supabase invite link (and with
    // their password set), activates their INVITED account.
    router.post("/complete-invite", apiLimiter, createAuthenticateIdentity({ verifyAccessToken }), async (req, res) => {
        try {
            const user = await completeInvitation({ db: await resolveDb(db), authUserId: req.identity.authUserId });
            return res.json({ user: toProfile({ ...user, adminId: user.userId }) });
        } catch (error) {
            if (error instanceof UserAccountError) return res.status(error.status).json({ message: error.message, code: error.code });
            throw error;
        }
    });

    return router;
}

export default createAuthRouter();
