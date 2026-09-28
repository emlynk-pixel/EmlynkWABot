// Admin Invitation API Router (Phase 12, Checkpoint 2).
//
// Endpoints mounted at /api/admin/invitations:
//   - POST /                       -> Issues an invitation (ADMIN only)
//   - GET /                        -> Lists invitations with computed status (ADMIN only)
//   - POST /:invitationId/revoke   -> Revokes a pending invitation (ADMIN only)
//
// RBAC is enforced via requireRole([ADMIN_ROLES.ADMIN]).
// Non-ADMIN callers receive 403 { message: "Insufficient permissions" }.

import express from "express";
import { requireRole, ADMIN_ROLES } from "../middleware/requireRole.js";
import {
    createInvitation,
    listInvitations,
    revokeInvitation,
    InvitationError,
} from "../services/adminInvitationService.js";

async function resolveDb(db) {
    return db ?? (await import("../config/prisma.js")).default;
}

const ADMINS_ONLY = [ADMIN_ROLES.ADMIN];

export function createInvitationRouter({ db } = {}) {
    const router = express.Router();

    // Issue a new invitation.
    router.post("/", requireRole(ADMINS_ONLY), async (req, res) => {
        try {
            const { name, email, role } = req.body ?? {};
            const client = await resolveDb(db);
            const invitation = await createInvitation({
                db: client,
                admin: req.admin,
                name,
                email,
                role,
            });
            return res.status(201).json({
                message: "Invitation sent successfully",
                invitation,
            });
        } catch (error) {
            if (error instanceof InvitationError) {
                return res.status(error.status).json({
                    message: error.message,
                    code: error.code ?? undefined,
                });
            }
            console.error("Create invitation error:", { errorType: error?.name ?? "Error" });
            return res.status(500).json({ message: "Internal server error" });
        }
    });

    // List all admin invitations.
    router.get("/", requireRole(ADMINS_ONLY), async (req, res) => {
        try {
            const client = await resolveDb(db);
            const invitations = await listInvitations({
                db: client,
                admin: req.admin,
            });
            return res.status(200).json({ invitations });
        } catch (error) {
            if (error instanceof InvitationError) {
                return res.status(error.status).json({
                    message: error.message,
                    code: error.code ?? undefined,
                });
            }
            console.error("List invitations error:", { errorType: error?.name ?? "Error" });
            return res.status(500).json({ message: "Internal server error" });
        }
    });

    // Revoke a pending invitation.
    router.post("/:invitationId/revoke", requireRole(ADMINS_ONLY), async (req, res) => {
        try {
            const client = await resolveDb(db);
            const result = await revokeInvitation({
                db: client,
                admin: req.admin,
                invitationId: req.params.invitationId,
            });
            return res.status(200).json(result);
        } catch (error) {
            if (error instanceof InvitationError) {
                return res.status(error.status).json({
                    message: error.message,
                    code: error.code ?? undefined,
                });
            }
            console.error("Revoke invitation error:", { errorType: error?.name ?? "Error" });
            return res.status(500).json({ message: "Internal server error" });
        }
    });

    return router;
}

export default createInvitationRouter();
