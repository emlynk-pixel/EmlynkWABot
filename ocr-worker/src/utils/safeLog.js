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
