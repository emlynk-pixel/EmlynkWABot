// In-memory stand-in for prisma.admin, prisma.adminInvitation, and prisma.auditLog.
// Used across auth, RBAC, provisioning, and invitation tests.
export function createFakeAdminDb(admins = [], { invitations = [], auditLogs = [] } = {}) {
    const rows = admins.map((admin) => ({ ...admin }));
    const invitationRows = invitations.map((inv) => ({ ...inv }));
    const auditLogRows = auditLogs.map((log) => ({ ...log }));

    const pick = (row, select) =>
        select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row };

    const db = {
        rows,
        invitationRows,
        auditLogRows,
        admin: {
            async findUnique({ where, select }) {
                const row = rows.find((r) =>
                    ("email" in where ? r.email === where.email : true) &&
                    ("adminId" in where ? r.adminId === where.adminId : true)
                );
                return row ? pick(row, select) : null;
            },
            // Mirrors the unique index on email (Prisma error P2002).
            async create({ data, select }) {
                if (rows.some((r) => r.email === data.email)) {
                    throw Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), { code: "P2002" });
                }
                const row = { ...data };
                rows.push(row);
                return pick(row, select);
            },
            async update({ where, data, select }) {
                const index = rows.findIndex((r) =>
                    ("adminId" in where ? r.adminId === where.adminId : true) &&
                    ("email" in where ? r.email === where.email : true)
                );
                if (index === -1) {
                    throw new Error("Record to update not found.");
                }
                rows[index] = { ...rows[index], ...data, updatedDate: new Date() };
                return pick(rows[index], select);
            },
            async findMany({ where = {} } = {}) {
                return rows.filter((r) =>
                    ("status" in where ? r.status === where.status : true) &&
                    ("role" in where ? r.role === where.role : true)
                ).map((r) => ({ ...r }));
            },
        },
        adminInvitation: {
            async findUnique({ where }) {
                const row = invitationRows.find((r) =>
                    ("tokenHash" in where ? r.tokenHash === where.tokenHash : true) &&
                    ("invitationId" in where ? r.invitationId === where.invitationId : true)
                );
                return row ? { ...row } : null;
            },
            async findFirst({ where }) {
                const row = invitationRows.find((r) =>
                    ("email" in where ? r.email === where.email : true) &&
                    ("status" in where ? r.status === where.status : true)
                );
                return row ? { ...row } : null;
            },
            async findMany({ where = {}, orderBy } = {}) {
                let result = invitationRows.filter((r) =>
                    ("email" in where ? r.email === where.email : true) &&
                    ("status" in where ? r.status === where.status : true)
                ).map((r) => ({ ...r }));

                if (Array.isArray(orderBy) && orderBy.length > 0) {
                    const [sortKey, sortDir] = Object.entries(orderBy[0])[0];
                    result.sort((a, b) => {
                        const aVal = a[sortKey];
                        const bVal = b[sortKey];
                        return sortDir === "desc" ? (aVal < bVal ? 1 : -1) : (aVal > bVal ? 1 : -1);
                    });
                }
                return result;
            },
            async create({ data }) {
                if (invitationRows.some((r) => r.tokenHash === data.tokenHash)) {
                    throw Object.assign(new Error("Unique constraint failed on token_hash"), { code: "P2002" });
                }
                const row = {
                    createdAt: new Date(),
                    status: "PENDING",
                    acceptedAt: null,
                    revokedAt: null,
                    ...data,
                };
                invitationRows.push(row);
                return { ...row };
            },
            async update({ where, data }) {
                const index = invitationRows.findIndex((r) => r.invitationId === where.invitationId);
                if (index === -1) {
                    throw new Error("Record to update not found.");
                }
                invitationRows[index] = { ...invitationRows[index], ...data };
                return { ...invitationRows[index] };
            },
            async updateMany({ where, data }) {
                let count = 0;
                for (let i = 0; i < invitationRows.length; i++) {
                    const matchesEmail = !("email" in where) || invitationRows[i].email === where.email;
                    const matchesStatus = !("status" in where) || invitationRows[i].status === where.status;
                    if (matchesEmail && matchesStatus) {
                        invitationRows[i] = { ...invitationRows[i], ...data };
                        count++;
                    }
                }
                return { count };
            },
        },
        auditLog: {
            async create({ data }) {
                const row = {
                    auditId: data.auditId,
                    adminId: data.adminId,
                    action: data.action,
                    previousStatus: data.previousStatus,
                    newStatus: data.newStatus,
                    reason: data.reason ?? null,
                    newValue: data.newValue ?? null,
                    previousValue: data.previousValue ?? null,
                    createdDate: new Date(),
                };
                auditLogRows.push(row);
                return { ...row };
            },
            async findMany({ where = {} } = {}) {
                return auditLogRows.filter((r) =>
                    ("action" in where ? r.action === where.action : true) &&
                    ("adminId" in where ? r.adminId === where.adminId : true)
                ).map((r) => ({ ...r }));
            },
        },
        async $transaction(fn) {
            return fn(db);
        },
    };

    return db;
}

// For tests about login logic rather than rate limiting.
export const noRateLimit = (req, res, next) => next();
