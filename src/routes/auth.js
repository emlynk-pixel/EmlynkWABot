import express from "express";

import { createApiRateLimiter } from "../middleware/apiRateLimiter.js";
import { createAuthenticateIdentity, createRequireActiveUser } from "../middleware/requireActiveUser.js";
import { activateOnPasswordSignIn, completeInvitation, invitationStatus, parseNameBody, updateOwnName, UserAccountError } from "../services/userAccountService.js";
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
    // A PASSWORD sign-in of a still-INVITED account first completes its invitation
    // (activateOnPasswordSignIn): the setup page's activation call may never have
    // arrived, or the password was set through "Forgot password". A revoked
    // (INACTIVE) account is never activated here.
    const [authenticate, loadActiveUser] = createRequireActiveUser({ db, verifyAccessToken });
    const completeOnPasswordSignIn = async (req, res, next) => {
        if (req.identity.amr?.includes("password")) {
            await activateOnPasswordSignIn({ db: await resolveDb(db), authUserId: req.identity.authUserId });
        }
        return next();
    };
    router.get("/me", apiLimiter, authenticate, completeOnPasswordSignIn, loadActiveUser, (req, res) => {
        res.json({ user: toProfile(req.user) });
    });

    // The signed-in user changes their own name (every role; only the name). Answers the new profile.
    router.put("/me/name", apiLimiter, authenticate, loadActiveUser, async (req, res) => {
        const parsed = parseNameBody(req.body);
        if (parsed.errors) return res.status(400).json({ message: "Invalid name", errors: parsed.errors });
        try {
            return res.json({ user: toProfile(await updateOwnName({ db: await resolveDb(db), actor: req.user, name: parsed.values.name })) });
        } catch (error) {
            if (error instanceof UserAccountError) return res.status(error.status).json({ message: error.message, code: error.code });
            throw error;
        }
    });

    // The setup page asks, BEFORE setting a password, whether this identity's
    // invitation is still valid: { status: "INVITED" | "ACTIVE" | "INACTIVE" | null }.
    router.get("/invitation", apiLimiter, createAuthenticateIdentity({ verifyAccessToken }), async (req, res) => {
        res.json({ status: await invitationStatus({ db: await resolveDb(db), authUserId: req.identity.authUserId }) });
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
