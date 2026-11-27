// Who receives a notification. Recipients are always read from public."user" on the server (role
// and status as stored now), never taken from a request. Only ACTIVE accounts receive anything.
//
// `roles` match EXACTLY (role IN roles): an audience that should follow the route tiers' inheritance
// (an OWNER holds every ADMIN permission, requireRole.js hasRole) is built with tierRoles() first.
// The Google Sheet split (E9 to ADMIN / TEAM_LEAD, F1 to OWNER) relies on the exact match.

import { ALL_ROLES, hasRole, ROLES } from "../middleware/requireRole.js";
import { USER_STATUS } from "../middleware/requireActiveUser.js";

// Every role a route tier admits, with hasRole's inheritance: tierRoles([ADMIN]) -> [OWNER, ADMIN].
export const tierRoles = (allowedRoles) => ALL_ROLES.filter((role) => hasRole(role, allowedRoles));

// The audiences of the notifications (notificationEvents.js). Team Leads and Owners receive every
// Admin notification; Admins receive no Team Lead or Owner-only one.
export const AUDIENCE = Object.freeze({
    ADMIN_TEAM: Object.freeze(tierRoles([ROLES.ADMIN, ROLES.TEAM_LEAD])),
    JOB_HANDLERS: Object.freeze([ROLES.JOB_HANDLER]),
    OWNERS: Object.freeze([ROLES.OWNER]),
    // Google Sheet sync: E9 goes to these exact roles, never to an Owner (who gets F1 instead).
    SHEET_SYNC_STAFF: Object.freeze([ROLES.ADMIN, ROLES.TEAM_LEAD]),
});

const idsOf = (values) => [...new Set((values ?? []).filter((id) => typeof id === "string" && id))];

// The ACTIVE users holding one of `roles` or named in `userIds`, minus `excludeUserIds` (e.g. the
// user who did the action): [{ adminId, role }], each once. One query, whatever the number of ids.
export async function resolveRecipients(db, { roles = [], userIds = [], excludeUserIds = [] } = {}) {
    const wantedRoles = [...new Set(roles)];
    const wantedIds = idsOf(userIds);
    const excluded = idsOf(excludeUserIds);
    if (!wantedRoles.length && !wantedIds.length) return [];
    const or = [];
    if (wantedRoles.length) or.push({ role: { in: wantedRoles } });
    if (wantedIds.length) or.push({ adminId: { in: wantedIds } });
    return db.user.findMany({
        where: { status: USER_STATUS.ACTIVE, OR: or, ...(excluded.length ? { adminId: { notIn: excluded } } : {}) },
        select: { adminId: true, role: true },
        orderBy: { adminId: "asc" },
    });
}

// Whether `user` (from resolveRecipients) is a recipient of `spec` ({ roles, userIds, requireRoles,
// excludeUserIds }). requireRoles: a user named in userIds receives it only while holding one of
// these roles. excludeUserIds: never these users (whatever their role), e.g. the acting user.
export const isRecipientOf = (user, { roles = [], userIds = [], requireRoles = null, excludeUserIds = [] }) => !(excludeUserIds ?? []).includes(user.adminId)
    && (roles.includes(user.role) || (userIds.includes(user.adminId) && (!requireRoles || requireRoles.includes(user.role))));
