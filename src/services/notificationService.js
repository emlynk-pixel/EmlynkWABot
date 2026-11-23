// In-app notifications: writing them (notify / notifyAll) and the signed-in user's own list
// (GET /api/admin/notifications, routes/admin.js). Table: public.notification, one row per
// recipient (migration 20261124120000_notifications). What each notification says and who gets it
// is in notificationEvents.js; recipients are resolved in notificationRecipients.js.
//
// Writing is best-effort and NEVER breaks the action that triggered it: every failure is caught and
// logged as one JSON line (notification.write_failed: the types, the error's class and Prisma code;
// never a title, message, name or identifier). Callers run it AFTER their transaction commits, with
// the root client, so a notification can never roll back or abort the action. Given a transaction
// client anyway, the insert runs under a savepoint, so a failure can't abort the outer transaction.
// One event is one row per recipient: (recipient_id, dedupe_key) is unique and the insert is
// ON CONFLICT DO NOTHING (createMany skipDuplicates), so a retried or repeated event adds nothing.
// Whatever the number of notifications in one call: one recipient query, one insert.
//
// Nothing here needs an environment variable or a service beyond the database: the Cloud Run sheet
// worker and the submission worker use it as it is.
//
// Reading is ALWAYS scoped to the caller (req.user.adminId, never a client-provided recipient): a
// notification of another user is 404 exactly like one that does not exist.

import { isRecipientOf, resolveRecipients } from "./notificationRecipients.js";
import { safePrismaErrorFields } from "../utils/safeLog.js";

export class NotificationError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = "NotificationError";
        this.status = status;
        this.code = code;
    }
}

// ---------------------------------------------------------------- writing

// A database client this can write with (the test fakes without a notification model are skipped).
const canNotify = (db) => typeof db?.notification?.createMany === "function" && typeof db?.user?.findMany === "function";
// A Prisma interactive-transaction client has no $transaction of its own.
const isTransactionClient = (db) => typeof db.$transaction !== "function" && typeof db.$executeRawUnsafe === "function";

function logWriteFailed(specs, error) {
    try {
        console.error(JSON.stringify({
            event: "notification.write_failed",
            types: [...new Set(specs.map((spec) => spec.type))],
            errorClass: error?.name ?? "Error",
            ...safePrismaErrorFields(error),
        }));
    } catch {
        // Logging must not throw either.
    }
}

async function insertRows(db, data) {
    if (!isTransactionClient(db)) return (await db.notification.createMany({ data, skipDuplicates: true })).count;
    await db.$executeRawUnsafe("SAVEPOINT notification_write");
    try {
        const { count } = await db.notification.createMany({ data, skipDuplicates: true });
        await db.$executeRawUnsafe("RELEASE SAVEPOINT notification_write");
        return count;
    } catch (error) {
        await db.$executeRawUnsafe("ROLLBACK TO SAVEPOINT notification_write").catch(() => {});
        throw error;
    }
}

// specs: [{ type, title, message, dedupeKey, roles?, userIds?, requireRoles?, excludeUserIds? }]
//   roles           exact roles (notificationRecipients.js AUDIENCE / tierRoles)
//   userIds         named users
//   requireRoles    with userIds: a named user receives it only while holding one of these roles
//   excludeUserIds  never these users (the acting user of E1 / E2), per spec
// Returns { created } (rows inserted; 0 when every recipient already had it). Never throws.
export async function notifyAll(db, specs) {
    const list = (specs ?? []).filter((spec) => spec && spec.type && spec.dedupeKey);
    if (!list.length || !canNotify(db)) return { created: 0 };
    try {
        const users = await resolveRecipients(db, {
            roles: list.flatMap((spec) => spec.roles ?? []),
            userIds: list.flatMap((spec) => spec.userIds ?? []),
        });
        const data = [];
        for (const spec of list) {
            for (const user of users) {
                if (!isRecipientOf(user, spec)) continue;
                data.push({ recipientId: user.adminId, type: spec.type, title: spec.title ?? null, message: spec.message ?? null, dedupeKey: spec.dedupeKey });
            }
        }
        if (!data.length) return { created: 0 };
        return { created: await insertRows(db, data) };
    } catch (error) {
        logWriteFailed(list, error);
        return { created: 0, failed: true };
    }
}

export const notify = (db, spec) => notifyAll(db, [spec]);

// ---------------------------------------------------------------- reading (the caller's own only)

export const DEFAULT_NOTIFICATION_PAGE_SIZE = 30;
export const MAX_NOTIFICATION_PAGE_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isValidNotificationId = (value) => typeof value === "string" && UUID_PATTERN.test(value);

// GET /api/admin/notifications?limit=1..100 (default 30)&cursor=<the previous page's nextCursor>
export function parseNotificationListQuery(query = {}) {
    const errors = [];
    let limit = DEFAULT_NOTIFICATION_PAGE_SIZE;
    if (query.limit !== undefined && query.limit !== "") {
        const value = typeof query.limit === "string" && /^\d+$/.test(query.limit) ? Number(query.limit) : NaN;
        if (!Number.isInteger(value) || value < 1 || value > MAX_NOTIFICATION_PAGE_SIZE) {
            errors.push({ field: "limit", message: `must be a whole number from 1 to ${MAX_NOTIFICATION_PAGE_SIZE}` });
        } else limit = value;
    }
    let cursor = null;
    if (query.cursor !== undefined && query.cursor !== "") {
        if (!isValidNotificationId(query.cursor)) errors.push({ field: "cursor", message: "must be the nextCursor of the previous page" });
        else cursor = query.cursor.toLowerCase();
    }
    return errors.length ? { errors } : { params: { limit, cursor } };
}

const iso = (value) => (value ? value.toISOString() : null);
const view = (row) => ({ id: row.id, type: row.type, title: row.title, message: row.message, createdAt: iso(row.createdAt), readAt: iso(row.readAt) });
const SELECT = { id: true, type: true, title: true, message: true, createdAt: true, readAt: true };
const ORDER = [{ createdAt: "desc" }, { id: "desc" }];

export const countUnread = ({ db, recipientId }) => db.notification.count({ where: { recipientId, readAt: null } });

// The caller's notifications, newest first, keyset-paged on (created_at, id). The cursor is a row
// id of THIS user (another user's id, or an unknown one, is refused).
export async function listNotifications({ db, recipientId, params }) {
    const { limit, cursor } = params;
    let where = { recipientId };
    if (cursor) {
        const from = await db.notification.findFirst({ where: { id: cursor, recipientId }, select: { id: true, createdAt: true } });
        if (!from) throw new NotificationError(400, "INVALID_CURSOR", "Invalid cursor");
        where = { recipientId, OR: [{ createdAt: { lt: from.createdAt } }, { createdAt: from.createdAt, id: { lt: from.id } }] };
    }
    const [rows, unreadCount] = await Promise.all([
        db.notification.findMany({ where, select: SELECT, orderBy: ORDER, take: limit + 1 }),
        countUnread({ db, recipientId }),
    ]);
    const items = rows.slice(0, limit).map(view);
    return { items, unreadCount, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
}

// POST /api/admin/notifications/:id/read. Idempotent: read_at is set only while it is null, so a
// second call keeps the first time. 404 for an id that is not the caller's.
export async function markNotificationRead({ db, recipientId, id, now = new Date() }) {
    const notFound = () => new NotificationError(404, "NOTIFICATION_NOT_FOUND", "Notification not found");
    if (!isValidNotificationId(id)) throw notFound();
    const notificationId = id.toLowerCase();
    await db.notification.updateMany({ where: { id: notificationId, recipientId, readAt: null }, data: { readAt: now } });
    const row = await db.notification.findFirst({ where: { id: notificationId, recipientId }, select: { id: true, readAt: true } });
    if (!row) throw notFound();
    return { id: row.id, readAt: iso(row.readAt), unreadCount: await countUnread({ db, recipientId }) };
}
