import { bearerToken, verifyWithSupabase } from "../auth/supabaseIdentity.js";
import { resolveDb } from "../utils/resolveClients.js";

// Application account status (public."user".status, a plain string).
//   INVITED   invited through Supabase Auth, setup not completed yet
//   ACTIVE    may use the application
//   INACTIVE  deactivated by an administrator
export const USER_STATUS = Object.freeze({ ACTIVE: "ACTIVE", INACTIVE: "INACTIVE", INVITED: "INVITED" });

export const AUTH_REQUIRED = Object.freeze({ message: "Authentication Token is required!" });
export const INVALID_TOKEN = Object.freeze({ message: "Invalid or Expired Token" });
export const ACCOUNT_NOT_ACTIVE = Object.freeze({ message: "Your account is not active. Contact an administrator.", code: "ACCOUNT_NOT_ACTIVE" });

// What req.user holds: never a credential.
export const USER_PROFILE_SELECT = Object.freeze({ adminId: true, authUserId: true, email: true, name: true, role: true, status: true });

// A valid, current Supabase session (Authorization: Bearer <access token>).
// Sets req.identity = { authUserId, email } from Supabase, never from the
// request body. 401 for a missing, invalid, expired or signed-out token.
export function createAuthenticateIdentity({ verifyAccessToken = verifyWithSupabase } = {}) {
    return async (req, res, next) => {
        const token = bearerToken(req);
        if (!token) return res.status(401).json(AUTH_REQUIRED);
        const identity = await verifyAccessToken(token);
        if (!identity) return res.status(401).json(INVALID_TOKEN);
        req.identity = identity;
        return next();
    };
}

export async function findUserByAuthId(db, authUserId) {
    const client = await resolveDb(db);
    return client.user.findUnique({ where: { authUserId }, select: USER_PROFILE_SELECT });
}

// For every protected route: the Supabase identity must be linked to a
// public."user" row whose status is ACTIVE. The row is read on every request,
// so a deactivation or role change applies to the very next request; role
// claims in the token are never used. A missing or inactive row fails closed
// with 403 (the identity is genuine, the application account is not usable).
// Express 5 forwards a rejected promise (Supabase or the database down) to
// the error handler, which answers a generic 500.
export function createRequireActiveUser({ db, verifyAccessToken } = {}) {
    const authenticate = createAuthenticateIdentity({ verifyAccessToken });
    const loadActiveUser = async (req, res, next) => {
        const user = await findUserByAuthId(db, req.identity.authUserId);
        if (!user || user.status !== USER_STATUS.ACTIVE) {
            return res.status(403).json(ACCOUNT_NOT_ACTIVE);
        }
        req.user = user;
        return next();
    };
    return [authenticate, loadActiveUser];
}
