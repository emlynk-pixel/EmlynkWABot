// Final Express error handler. Without it, Express shows its own error page,
// which (unless NODE_ENV=production) includes the stack trace, file paths and
// the local user name. This handler answers the same way in every environment.

import { safePrismaErrorFields } from "../utils/safeLog.js";

const MESSAGES = {
    400: "Invalid request body",
    413: "Request payload too large",
    500: "Internal server error",
};

// Errors from the JSON body parser carry a `type` and a 4xx status.
// Anything else is treated as an internal error.
function statusFor(error) {
    if (error?.type === "entity.too.large") return 413;

    const isBodyError = typeof error?.type === "string" && error.status >= 400 && error.status < 500;
    return isBodyError ? 400 : 500;
}

// --- TEMPORARY DIAGNOSTIC LOGGING START ---
function sanitizeDiagnosticText(text) {
    if (typeof text !== "string") return text;
    return text
        // Redact database connection URLs (user:password@host)
        .replace(/(postgres(?:ql)?:\/\/)(?:[^:@\s]+)(?::(?:[^@\s]+))?@/gi, "$1[redacted]@")
        // Redact credentials, tokens, secrets, passwords
        .replace(/(?:password|secret|key|token|apiKey|access_token|authorization)[=:\s]+["']?([^\s"';,&]+)["']?/gi, "password=[redacted]")
        .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
        .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+/g, "[jwt_redacted]");
}

function sanitizeDiagnosticValue(val) {
    if (val === null || val === undefined) return val;
    if (typeof val === "string") return sanitizeDiagnosticText(val);
    if (typeof val === "number" || typeof val === "boolean") return val;
    if (Array.isArray(val)) return val.map(sanitizeDiagnosticValue);
    if (typeof val === "object") {
        const cleaned = {};
        for (const [k, v] of Object.entries(val)) {
            if (/password|secret|token|credential|auth/i.test(k)) {
                cleaned[k] = "[redacted]";
            } else {
                cleaned[k] = sanitizeDiagnosticValue(v);
            }
        }
        return cleaned;
    }
    return String(val);
}

function extractUnderlyingDbError(message) {
    if (typeof message !== "string") return null;
    const connectorMatch = message.match(/PostgresError\s*\{\s*code:\s*"([^"]+)",\s*message:\s*"([^"]+)",\s*severity:\s*"([^"]+)"/);
    if (connectorMatch) {
        return {
            code: connectorMatch[1],
            message: connectorMatch[2],
            severity: connectorMatch[3],
        };
    }
    const rawMatch = message.match(/Code:\s*`?([0-9A-Z]{5})`?\.?\s*Message:\s*`?([^`\n]+)`?/);
    if (rawMatch) {
        return {
            code: rawMatch[1],
            message: rawMatch[2].trim(),
        };
    }
    return null;
}

function isCandidateEndpoint(req) {
    const fullPath = `${req?.baseUrl || ""}${req?.path || ""}`;
    return fullPath.includes("/candidates");
}

export function logPrismaDiagnostic(error, req = {}) {
    const errorName = error?.name ?? error?.constructor?.name ?? "Error";
    const isPrisma = errorName.startsWith("Prisma") ||
                     errorName === "DatabaseError" ||
                     (typeof error?.code === "string" && (/^P\d{4}$/.test(error.code) || /^[0-9A-Z]{5}$/.test(error.code)));

    if (!isPrisma || !isCandidateEndpoint(req)) return;

    const code = error?.code ?? null;
    const rawMessage = error?.message ?? "";
    const sanitizedMessage = sanitizeDiagnosticText(rawMessage);
    const meta = error?.meta ? sanitizeDiagnosticValue(error.meta) : null;

    let cause = null;
    if (error?.cause) {
        if (typeof error.cause === "object") {
            cause = {
                name: error.cause.name ?? error.cause.constructor?.name ?? "Error",
                message: sanitizeDiagnosticText(error.cause.message ?? ""),
                code: error.cause.code ?? null,
                severity: error.cause.severity ?? null,
            };
        } else {
            cause = sanitizeDiagnosticText(String(error.cause));
        }
    }

    const underlying = extractUnderlyingDbError(rawMessage);

    console.error("[PRISMA_DIAGNOSTIC_ERROR]", {
        endpoint: req.method ? `${req.method} ${req.baseUrl || ""}${req.path || ""}` : undefined,
        name: errorName,
        code,
        message: sanitizedMessage,
        cause,
        meta,
        underlyingDbError: underlying ?? (code && /^[0-9A-Z]{5}$/.test(code) ? { code, message: sanitizedMessage } : null),
    });
}
// --- TEMPORARY DIAGNOSTIC LOGGING END ---

// Express recognises an error handler by its four parameters, so `next`
// must stay in the signature even though it's only used when a response
// has already started.
export function errorHandler(error, req, res, next) {
    if (res.headersSent) {
        return next(error);
    }

    const status = statusFor(error);

    // Safe metadata only: no message, stack, body or query string (the
    // webhook verification request carries its token in the query). A Prisma
    // error additionally gets its `.code` and an allowlisted, value-free
    // subset of `.meta` (e.g. P2021/table) - see safePrismaErrorFields.
    console.error("Request failed:", {
        method: req.method,
        path: `${req.baseUrl}${req.path}`,
        status,
        type: error?.type ?? error?.name ?? "Error",
        ...safePrismaErrorFields(error),
    });

    // TEMPORARY DIAGNOSTIC LOGGING FOR 20-VU LOAD TEST PRISMA ERRORS
    logPrismaDiagnostic(error, req);

    return res.status(status).json({ message: MESSAGES[status] });
}
