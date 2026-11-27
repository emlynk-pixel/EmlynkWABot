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

// Express recognises an error handler by its four parameters, so `next`
// must stay in the signature even though it's only used when a response
// has already started.
// onServerError(error): told about every 500 after the answer is sent (the
// Owner's System Alert, notificationEvents.js createSystemAlertReporter). It
// must not throw or block; it is guarded anyway, so it can never reach this
// handler again or change the response.
export function createErrorHandler({ onServerError = null } = {}) {
    return function errorHandler(error, req, res, next) {
        if (res.headersSent) {
            return next(error);
        }
        const answered = answer(error, req, res);
        if (onServerError && res.statusCode === 500) {
            try {
                onServerError(error);
            } catch {
                // Never surfaces: the response has been sent.
            }
        }
        return answered;
    };
}

// Without a System Alert reporter (the tests, and any app built without one).
export const errorHandler = createErrorHandler();

function answer(error, req, res) {
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

    return res.status(status).json({ message: MESSAGES[status] });
}
