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
    }

    return Object.keys(meta).length > 0
        ? { prismaCode: error.code, prismaMeta: meta }
        : { prismaCode: error.code };
}
