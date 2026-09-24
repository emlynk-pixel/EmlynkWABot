// Minimal in-memory stand-in for the Prisma calls the services make.
// Supports only the query shapes the code uses, and records every call.
export function createFakePrisma(users = []) {
    const rows = users.map((user) => ({ ...user }));
    const calls = [];

    const matches = (row, where) =>
        Object.entries(where).every(([field, condition]) => {
            const value = row[field];

            if (condition === null) return value === null || value === undefined;
            if (typeof condition !== "object") return value === condition;

            if ("equals" in condition) {
                return condition.mode === "insensitive"
                    ? String(value ?? "").toLowerCase() === String(condition.equals).toLowerCase()
                    : value === condition.equals;
            }
            if ("endsWith" in condition) return String(value ?? "").endsWith(condition.endsWith);

            throw new Error(`fakePrisma: unsupported condition on ${field}`);
        });

    const pick = (row, select) =>
        select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key] ?? null])) : { ...row };

    return {
        calls,
        rows,
        user: {
            async findMany({ where = {}, select, take } = {}) {
                calls.push({ method: "user.findMany", where });
                const found = rows.filter((row) => matches(row, where)).map((row) => pick(row, select));
                return take ? found.slice(0, take) : found;
            },
            async updateMany({ where = {}, data }) {
                calls.push({ method: "user.updateMany", where, data });
                const targets = rows.filter((row) => matches(row, where));
                targets.forEach((row) => Object.assign(row, data));
                return { count: targets.length };
            },
        },
        temporaryData: {
            async create({ data }) {
                calls.push({ method: "temporaryData.create", data });
                return { ...data };
            },
            async update({ where, data }) {
                calls.push({ method: "temporaryData.update", where, data });
                return { ...where, ...data };
            },
        },
    };
}
