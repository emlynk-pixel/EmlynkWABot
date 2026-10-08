// In-memory stand-in for prisma.user (application users) and prisma.auditLog.
// Used across auth, RBAC, user-management and provisioning tests.
// A fixture row without authUserId gets the one authIdFor(adminId) gives, so
// tokenFor(adminId) (fakeSupabaseAuth.js) signs it in.
import { authIdFor } from "./fakeSupabaseAuth.js";

const KEYS = ["adminId", "email", "authUserId"];

export function createFakeAdminDb(users = [], { auditLogs = [] } = {}) {
    const rows = users.map((user) => ({
        createdDate: new Date("2026-10-01T00:00:00Z"),
        status: "ACTIVE",
        ...user,
        authUserId: user.authUserId === undefined ? authIdFor(user.adminId) : user.authUserId,
    }));
    const auditLogRows = auditLogs.map((log) => ({ ...log }));

    const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row });
    const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => row[key] === value);
    const uniqueViolation = (field) => Object.assign(new Error(`Unique constraint failed on the fields: (\`${field}\`)`), { code: "P2002", meta: { target: [field] } });
    const assertUnique = (candidate, except = null) => {
        for (const field of KEYS) {
            if (candidate[field] == null) continue;
            if (rows.some((r) => r !== except && r[field] === candidate[field])) throw uniqueViolation(field);
        }
    };
    const findOne = (where) => {
        const keys = Object.keys(where);
        if (!keys.length || keys.some((key) => !KEYS.includes(key))) throw new Error(`fakeAdminDb: unsupported unique lookup ${keys}`);
        return rows.find((r) => matches(r, where)) ?? null;
    };

    const db = {
        rows,
        auditLogRows,
        user: {
            async findUnique({ where, select }) {
                const row = findOne(where);
                return row ? pick(row, select) : null;
            },
            async findMany({ where = {}, select } = {}) {
                return rows.filter((r) => matches(r, where)).map((r) => pick(r, select));
            },
            async create({ data, select }) {
                const row = { createdDate: new Date(), status: "ACTIVE", ...data };
                assertUnique(row);
                rows.push(row);
                return pick(row, select);
            },
            async update({ where, data, select }) {
                const row = findOne(where);
                if (!row) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
                assertUnique({ ...row, ...data }, row);
                Object.assign(row, data, { updatedDate: new Date() });
                return pick(row, select);
            },
            async updateMany({ where = {}, data }) {
                const targets = rows.filter((r) => matches(r, where));
                targets.forEach((row) => Object.assign(row, data, { updatedDate: new Date() }));
                return { count: targets.length };
            },
            async upsert({ where, create, update }) {
                const row = findOne(where);
                if (row) return db.user.update({ where, data: update });
                return db.user.create({ data: create });
            },
        },
        auditLog: {
            async create({ data }) {
                const row = { reason: null, previousValue: null, newValue: null, ...data, createdDate: new Date() };
                auditLogRows.push(row);
                return { ...row };
            },
            async findMany({ where = {} } = {}) {
                return auditLogRows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
            },
        },
        async $transaction(fn) {
            return fn(db);
        },
    };

    return db;
}

// For tests about authentication rather than rate limiting.
export const noRateLimit = (req, res, next) => next();
