// In-memory stand-in for prisma.admin, with the two query shapes the auth
// routes use: findUnique by email (login) and by adminId (/auth/me).
export function createFakeAdminDb(admins) {
    const rows = admins.map((admin) => ({ ...admin }));
    const pick = (row, select) =>
        select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row };

    return {
        rows,
        admin: {
            async findUnique({ where, select }) {
                const row = rows.find((r) =>
                    ("email" in where ? r.email === where.email : true) &&
                    ("adminId" in where ? r.adminId === where.adminId : true)
                );
                return row ? pick(row, select) : null;
            },
        },
    };
}

// For tests about login logic rather than rate limiting.
export const noRateLimit = (req, res, next) => next();
