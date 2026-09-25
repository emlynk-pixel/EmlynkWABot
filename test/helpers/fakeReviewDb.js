// In-memory stand-in for the Prisma calls the review queue, review detail
// and review actions make. Mirrors what those rely on in PostgreSQL:
//   - where clauses (AND / OR / not / in / relation `is`) are evaluated;
//   - $transaction runs one callback at a time (standing in for the row
//     locks) and restores every table if the callback throws;
//   - documents are unique per (passportId, fileSha256) (P2002);
//   - audit_logs rows can't be updated or deleted (the migration's trigger).
// `failOn` makes one method throw once, e.g. { "document.create": new Error() }.
import { createFakeAdminDb } from "./fakeAdminDb.js";

export function createFakeReviewDb({ admins = [], users = [], temporaryData = [], documents = [], auditLogs = [], failOn = {} } = {}) {
    const tables = {
        user: users.map((row) => ({ ...row })),
        temporaryData: temporaryData.map((row) => ({ ...row })),
        document: documents.map((row) => ({ ...row })),
        auditLog: auditLogs.map((row) => ({ ...row })),
    };
    const adminDb = createFakeAdminDb(admins);
    const calls = [];
    const failures = { ...failOn };

    const relations = {
        temporaryData: { user: (r) => tables.user.find((u) => u.passportId === r.passportId) ?? null },
        document: {
            user: (r) => tables.user.find((u) => u.passportId === r.passportId) ?? null,
            temporaryData: (r) => tables.temporaryData.find((t) => t.temporaryId === r.temporaryId) ?? null,
        },
        auditLog: { admin: (r) => adminDb.rows.find((a) => a.adminId === r.adminId) ?? null },
        user: { documents: (r) => tables.document.filter((d) => d.passportId === r.passportId) },
    };
    const relationModel = { user: "user", temporaryData: "temporaryData", admin: "admin", documents: "document" };

    function matches(model, row, where) {
        if (!where) return true;
        return Object.entries(where).every(([key, cond]) => {
            if (key === "AND") return cond.every((c) => matches(model, row, c));
            if (key === "OR") return cond.some((c) => matches(model, row, c));
            const relation = relations[model]?.[key];
            if (relation) {
                const related = relation(row);
                if (cond && "is" in cond) return cond.is === null ? related === null : related !== null && matches(relationModel[key], related, cond.is);
                throw new Error(`fakeReviewDb: unsupported relation filter ${model}.${key}`);
            }
            const value = row[key] ?? null;
            if (cond === null || typeof cond !== "object" || cond instanceof Date) {
                return value === cond || (value instanceof Date && cond instanceof Date && +value === +cond);
            }
            return Object.entries(cond).every(([op, arg]) => {
                if (op === "not") return arg === null ? value !== null : value !== arg;
                if (op === "equals") return value === arg;
                if (op === "in") return arg.includes(value);
                if (op === "gte") return value !== null && value >= arg;
                if (op === "lt") return value !== null && value < arg;
                throw new Error(`fakeReviewDb: unsupported operator ${key}.${op}`);
            });
        });
    }

    const withRelations = (model, row) => {
        const out = { ...row };
        for (const [name, get] of Object.entries(relations[model] ?? {})) out[name] = get(row);
        return out;
    };

    function sortRows(rows, orderBy = []) {
        const keys = [orderBy].flat();
        return [...rows].sort((a, b) => {
            for (const key of keys) {
                const [field, direction] = Object.entries(key)[0];
                const x = a[field] instanceof Date ? +a[field] : a[field];
                const y = b[field] instanceof Date ? +b[field] : b[field];
                if (x === y) continue;
                return (x < y ? -1 : 1) * (direction === "desc" ? -1 : 1);
            }
            return 0;
        });
    }

    const maybeFail = (name) => {
        if (failures[name]) {
            const error = failures[name];
            delete failures[name];
            throw error;
        }
    };

    function model(name) {
        const rows = () => tables[name];
        const filter = (where) => rows().filter((row) => matches(name, row, where));
        const record = (method, args) => { calls.push({ method: `${name}.${method}`, args }); maybeFail(`${name}.${method}`); };
        return {
            async count(args = {}) { record("count", args); return filter(args.where).length; },
            async findMany(args = {}) {
                record("findMany", args);
                const { where, orderBy, skip = 0, take } = args;
                return sortRows(filter(where), orderBy).slice(skip, take === undefined ? undefined : skip + take).map((row) => withRelations(name, row));
            },
            async findFirst(args = {}) {
                record("findFirst", args);
                const row = sortRows(filter(args.where), args.orderBy)[0];
                return row ? withRelations(name, row) : null;
            },
            async findUnique(args = {}) { record("findUnique", args); const row = filter(args.where)[0]; return row ? withRelations(name, row) : null; },
            async groupBy({ by, where }) {
                record("groupBy", { by, where });
                const groups = new Map();
                for (const row of filter(where)) {
                    const key = JSON.stringify(by.map((field) => row[field] ?? null));
                    groups.set(key, (groups.get(key) ?? 0) + 1);
                }
                return [...groups].map(([key, n]) => ({ ...Object.fromEntries(by.map((field, i) => [field, JSON.parse(key)[i]])), _count: { _all: n } }));
            },
            async create({ data }) {
                record("create", { data });
                if (name === "document" && data.fileSha256 && rows().some((d) => d.passportId === data.passportId && d.fileSha256 === data.fileSha256)) {
                    throw Object.assign(new Error("Unique constraint failed on the fields: (`passport_id`,`file_sha256`)"), { code: "P2002" });
                }
                const row = { createdDate: new Date(), ...data };
                rows().push(row);
                return { ...row };
            },
            async update({ where, data }) {
                record("update", { where, data });
                if (name === "auditLog") throw new Error("audit_logs is append-only: UPDATE is not allowed");
                const row = filter(where)[0];
                if (!row) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
                Object.assign(row, data);
                return { ...row };
            },
            async updateMany({ where, data }) {
                record("updateMany", { where, data });
                if (name === "auditLog") throw new Error("audit_logs is append-only: UPDATE is not allowed");
                const targets = filter(where);
                targets.forEach((row) => Object.assign(row, data));
                return { count: targets.length };
            },
            async delete({ where }) {
                record("delete", { where });
                if (name === "auditLog") throw new Error("audit_logs is append-only: DELETE is not allowed");
                const row = filter(where)[0];
                tables[name] = rows().filter((r) => r !== row);
                return row;
            },
            async deleteMany({ where } = {}) {
                record("deleteMany", { where });
                if (name === "auditLog") throw new Error("audit_logs is append-only: DELETE is not allowed");
                const before = rows().length;
                tables[name] = rows().filter((r) => !matches(name, r, where));
                return { count: before - tables[name].length };
            },
        };
    }

    // SELECT … FOR UPDATE lock queries: returns the locked key if the row exists.
    async function $queryRaw(strings, ...values) {
        const sql = strings.join("?");
        calls.push({ method: "$queryRaw", sql, values });
        const [value] = values;
        if (/FROM "users"/.test(sql)) return tables.user.filter((u) => u.passportId === value).map((u) => ({ passport_id: u.passportId }));
        if (/FROM "temporary_data"/.test(sql)) return tables.temporaryData.filter((t) => t.temporaryId === value).map((t) => ({ temporary_id: t.temporaryId }));
        if (/FROM "documents"/.test(sql)) return tables.document.filter((d) => d.documentId === value).map((d) => ({ document_id: d.documentId }));
        throw new Error(`fakeReviewDb: unexpected raw query ${sql}`);
    }

    const client = {
        admin: adminDb.admin,
        user: model("user"),
        temporaryData: model("temporaryData"),
        document: model("document"),
        auditLog: model("auditLog"),
        $queryRaw,
    };

    // One transaction at a time; tables restored if the callback throws.
    let queue = Promise.resolve();
    client.$transaction = (callback, options) => {
        calls.push({ method: "$transaction", options });
        const run = queue.then(async () => {
            const snapshot = Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]));
            try {
                return await callback(client);
            } catch (error) {
                Object.assign(tables, snapshot);
                throw error;
            }
        });
        queue = run.catch(() => {});
        return run;
    };

    return { client, tables, calls, adminRows: adminDb.rows, failNext: (name, error) => { failures[name] = error; } };
}
