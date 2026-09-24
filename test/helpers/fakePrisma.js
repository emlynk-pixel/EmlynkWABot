// Minimal in-memory stand-in for the Prisma calls the services make.
// Supports only the query shapes the code uses, and records every call.
//   users:          array of user rows
//   documents:      array of documents rows (unique per passportId + fileSha256, like the real index)
//   temporaryData:  array of temporary_data rows (only needed for lookups)
export function createFakePrisma(users = [], { documents = [], temporaryData = [] } = {}) {
    const rows = users.map((user) => ({ ...user }));
    const documentRows = documents.map((document) => ({ ...document }));
    const temporaryRows = temporaryData.map((row) => ({ ...row }));
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
            if ("not" in condition) {
                return condition.not === null
                    ? value !== null && value !== undefined
                    : value !== condition.not;
            }

            throw new Error(`fakePrisma: unsupported condition on ${field}`);
        });

    const pick = (row, select) =>
        select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key] ?? null])) : { ...row };

    // Same error shape Prisma uses for a unique-constraint violation.
    const uniqueViolation = (target) =>
        Object.assign(new Error(`Unique constraint failed on the fields: (${target.join(", ")})`), {
            code: "P2002",
            meta: { target },
        });

    return {
        calls,
        rows,
        documentRows,
        temporaryRows,
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
        document: {
            async findFirst({ where = {}, select } = {}) {
                calls.push({ method: "document.findFirst", where });
                const found = documentRows.find((row) => matches(row, where));
                return found ? pick(found, select) : null;
            },
            async count({ where = {} } = {}) {
                calls.push({ method: "document.count", where });
                return documentRows.filter((row) => matches(row, where)).length;
            },
            async create({ data }) {
                calls.push({ method: "document.create", data });
                const clash = documentRows.some(
                    (row) => data.fileSha256 && row.passportId === data.passportId && row.fileSha256 === data.fileSha256
                );
                if (clash) throw uniqueViolation(["passport_id", "file_sha256"]);
                documentRows.push({ ...data });
                return { ...data };
            },
        },
        temporaryData: {
            async create({ data }) {
                calls.push({ method: "temporaryData.create", data });
                return { ...data };
            },
            async findFirst({ where = {}, select } = {}) {
                calls.push({ method: "temporaryData.findFirst", where });
                const found = temporaryRows.find((row) => matches(row, where));
                return found ? pick(found, select) : null;
            },
            async update({ where, data }) {
                calls.push({ method: "temporaryData.update", where, data });
                return { ...where, ...data };
            },
        },
    };
}
