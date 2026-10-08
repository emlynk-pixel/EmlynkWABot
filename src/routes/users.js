// User management, mounted at /api/admin/users (ADMIN only). Runs after the
// admin router's requireActiveUser, so req.user is the ACTIVE caller loaded
// from public."user".
//
//   GET  /                     list application users
//   POST /invite               invite (or re-invite / reactivate) a user
//   PUT  /:userId/role         change a user's role
//   POST /:userId/deactivate   deactivate a user (also revokes a pending invite)

import express from "express";

import { requireRole, ROLES } from "../middleware/requireRole.js";
import { getSupabaseAuthAdmin } from "../auth/supabaseAuthAdmin.js";
import {
    deactivateUser,
    inviteUser,
    listUsers,
    parseInviteBody,
    updateUserRole,
    UserAccountError,
} from "../services/userAccountService.js";
import { resolveDb } from "../utils/resolveClients.js";

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Where Supabase sends the invitee: the admin app's setup page. Unset, the
// Supabase project's Site URL is used. Must be in the project's allowed
// redirect URLs.
export function inviteRedirectUrl(env = process.env) {
    const base = env.APP_BASE_URL?.trim().replace(/\/+$/, "");
    return base ? `${base}/admin/setup-password` : undefined;
}

export function createUsersRouter({ db, authAdmin, env = process.env } = {}) {
    const router = express.Router();
    router.use(requireRole([ROLES.ADMIN]));

    const handle = (work) => async (req, res) => {
        try {
            return await work(req, res, await resolveDb(db));
        } catch (error) {
            if (error instanceof UserAccountError) {
                return res.status(error.status).json({ message: error.message, code: error.code });
            }
            throw error;
        }
    };
    const validUserId = (req, res) => {
        if (USER_ID_PATTERN.test(req.params.userId)) return true;
        res.status(400).json({ message: "Invalid user ID" });
        return false;
    };

    router.get("/", handle(async (req, res, client) => res.json({ users: await listUsers({ db: client }) })));

    router.post("/invite", handle(async (req, res, client) => {
        const parsed = parseInviteBody(req.body);
        if (parsed.errors) return res.status(400).json({ message: "Invalid invitation", errors: parsed.errors });
        const result = await inviteUser({
            db: client,
            authAdmin: authAdmin ?? (await getSupabaseAuthAdmin()),
            actor: req.user,
            values: parsed.values,
            redirectTo: inviteRedirectUrl(env),
        });
        return res.status(result.outcome === "INVITED" ? 201 : 200).json(result);
    }));

    router.put("/:userId/role", handle(async (req, res, client) => {
        if (!validUserId(req, res)) return undefined;
        return res.json({ user: await updateUserRole({ db: client, actor: req.user, userId: req.params.userId, role: req.body?.role }) });
    }));

    router.post("/:userId/deactivate", handle(async (req, res, client) => {
        if (!validUserId(req, res)) return undefined;
        return res.json({ user: await deactivateUser({ db: client, actor: req.user, userId: req.params.userId }) });
    }));

    return router;
}
