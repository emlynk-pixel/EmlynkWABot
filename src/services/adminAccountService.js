import { ALL_ROLES } from "../middleware/requireRole.js";
import { ACTIVE_ADMIN_STATUS } from "../middleware/requireActiveAdmin.js";

export class AdminAccountError extends Error {
    constructor(message, status = 400, code = null) {
        super(message);
        this.name = "AdminAccountError";
        this.status = status;
        this.code = code;
    }
}

export async function listAdmins({ db }) {
    const admins = await db.admin.findMany({
        select: {
            adminId: true,
            name: true,
            email: true,
            role: true,
            status: true,
            createdDate: true,
        },
        orderBy: [
            { status: 'asc' }, // Active first
            { createdDate: 'desc' },
        ],
    });
    return admins;
}

export async function updateAdminRole({ db, admin, targetAdminId, newRole }) {
    // Only ADMIN can change roles. This is checked by the router, but double-checking here.
    if (admin.role !== "ADMIN") {
        throw new AdminAccountError("Insufficient permissions to change roles", 403, "FORBIDDEN");
    }

    if (!ALL_ROLES.includes(newRole)) {
        throw new AdminAccountError(`Invalid role: ${newRole}`);
    }

    // Cannot change your own role to prevent lockout
    if (admin.adminId === targetAdminId) {
        throw new AdminAccountError("Cannot change your own role");
    }

    const targetAdmin = await db.admin.findUnique({
        where: { adminId: targetAdminId },
    });

    if (!targetAdmin) {
        throw new AdminAccountError("Admin not found", 404, "NOT_FOUND");
    }

    const updated = await db.admin.update({
        where: { adminId: targetAdminId },
        data: { role: newRole },
        select: { adminId: true, name: true, email: true, role: true, status: true },
    });

    await db.auditLog.create({
        data: {
            adminId: admin.adminId,
            action: "UPDATE_ADMIN_ROLE",
            targetId: targetAdminId,
            details: { previousRole: targetAdmin.role, newRole },
        },
    });

    return updated;
}
