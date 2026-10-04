// Error text that is safe to log (SEC-011).
//
// Messages from the database driver, Supabase or pdf.js are useful for
// debugging but can quote values: a passport number, a phone number, a
// storage path with a client ID. Only the first line is kept (Prisma puts the
// query arguments on later lines) and anything that looks like data is
// replaced with a placeholder. Backticks are kept: Prisma uses them for
// method and field names, never for values.

const MAX_LENGTH = 200;

const REDACTIONS = [
    // Quoted values: "N1234567", 'x'
    [/"[^"]*"|'[^']*'/g, "[redacted]"],
    // Storage paths, which contain passport IDs, unique IDs or temporary IDs
    [/\b(?:clients|pending|temporary)\/\S*/g, "[path]"],
    // Email addresses
    [/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]"],
    // Passport-like IDs (letters followed by digits) and long numbers (phones)
    [/\b[A-Za-z]{1,2}\d{6,9}\b/g, "[id]"],
    [/\+?\d{7,}/g, "[number]"],
];

export function safeErrorText(error) {
    let text = String(error?.message ?? error ?? "").split("\n")[0];
    for (const [pattern, replacement] of REDACTIONS) {
        text = text.replace(pattern, replacement);
    }
    return text.slice(0, MAX_LENGTH);
}

// For log lines: the error class and a redacted message, never the stack,
// the error object itself or properties such as `meta` that hold values.
export function safeErrorInfo(error) {
    return { errorType: error?.name ?? "Error", error: safeErrorText(error) };
}

// Prisma's `.code` (e.g. "P2021") identifies which failure happened; `.meta`
// names the schema object involved (table/column/model/constraint). Neither
// ever holds row data, but `.meta` is a free-form object whose shape depends
// on the code, so only this fixed allowlist of keys is kept, and only when
// their value is a plain string or array of strings (Prisma's own shape for
// these keys) - anything else is dropped rather than risk leaking a value.
// `.message` is never read here: on a raw query (e.g. $queryRaw) it can
// include the driver's own error text, which is exactly what this avoids.
const SAFE_PRISMA_META_KEYS = ["modelName", "table", "column", "field_name", "constraint", "target"];

function isSafePrismaMetaValue(value) {
    if (typeof value === "string") return true;
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// P2010 ("raw query failed", e.g. from $queryRaw/$executeRaw) carries the
// underlying driver failure instead of the schema-name keys above, as
// `meta.code` + `meta.message`. `meta.code` is the driver/Postgres SQLSTATE
// (a fixed 5-character code such as "42501" permission denied or "42P01"
// relation does not exist, see
// https://www.postgresql.org/docs/current/errcodes-appendix.html) - a
// category label, never a value, so it's safe to log. `meta.message` is not:
// for a raw query it can quote the failing SQL text or values, so it is
// never read here.
//
// Confirmed shape: reproduced locally against this project's exact stack
// (PrismaClient 6.19.3 + `@prisma/adapter-pg`, config/prisma.js) by forcing
// a `$queryRaw`/`$executeRaw` call to fail against a stubbed `pg.Pool`. The
// resulting `PrismaClientKnownRequestError` is `{ code: "P2010", meta: {
// code: "<SQLSTATE>", message: "<driver message>" } }` - Prisma normalizes
// driver-adapter raw-query failures back to this flat shape for backward
// compatibility with the classic query engine's public contract, even
// though internally (see @prisma/adapter-pg's `convertDriverError`) the
// error is first mapped into a richer `{ kind, originalCode,
// originalMessage }` object. That richer shape is not what reaches
// application code through the public `.meta` property and is not read
// here.
//
// Kept separate from the generic allowlist above (and from the outer
// `prismaCode`) so a future code reusing a "code" key in `.meta` for
// something else isn't trusted by accident.
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

function safeRawQueryMeta(meta) {
    if (meta && typeof meta.code === "string" && SQLSTATE_PATTERN.test(meta.code)) {
        return { dbErrorCode: meta.code };
    }
    return null;
}

// Duck-typed on `.code` matching Prisma's "P" + 4 digits format, so this
// doesn't need to import the generated client just to check `instanceof`.
// Returns null for anything else (including non-Prisma errors).
export function safePrismaErrorFields(error) {
    if (typeof error?.code !== "string" || !/^P\d{4}$/.test(error.code)) {
        return null;
    }

    const meta = {};
    if (error.meta && typeof error.meta === "object") {
        for (const key of SAFE_PRISMA_META_KEYS) {
            if (key in error.meta && isSafePrismaMetaValue(error.meta[key])) {
                meta[key] = error.meta[key];
            }
        }
        if (error.code === "P2010") {
            Object.assign(meta, safeRawQueryMeta(error.meta));
        }
    }

    return Object.keys(meta).length > 0
        ? { prismaCode: error.code, prismaMeta: meta }
        : { prismaCode: error.code };
}
