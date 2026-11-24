// Minimal JSON client for the EmlynkWABot backend. Requests are same-origin:
// in production Express serves this app, in development Vite proxies /auth and /api.
//
// Authentication: the current Supabase access token as Authorization: Bearer
// (no cookie is used or sent). AuthProvider keeps the token current, including
// after Supabase refreshes it; a page may also pass one explicitly.

let currentAccessToken: string | null = null;

export function setApiAccessToken(token: string | null): void {
    currentAccessToken = token;
}

function authorizationToken(token?: string): string | null {
    return token || currentAccessToken;
}

// fieldErrors: a 400 with { errors: [{ field, message }] } (the server's
// validation), so a form can mark the fields to fix.
export type FieldError = { field: string; message: string };

export class ApiError extends Error {
    readonly status: number;
    readonly resetTime?: Date;
    readonly fieldErrors: FieldError[];
    // A 409 of the import API: a machine code (e.g. IMPORT_ALREADY_ACTIVE) and the details to act on it
    // (import id, committed chunks); undefined elsewhere.
    readonly code?: string;
    readonly details?: Record<string, unknown>;

    constructor(status: number, message: string, resetTime?: Date, fieldErrors: FieldError[] = [], code?: string, details?: Record<string, unknown>) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.resetTime = resetTime;
        this.fieldErrors = fieldErrors;
        this.code = code;
        this.details = details;
    }
}

type RequestOptions = {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
    token?: string;
    // Extra request headers (e.g. Idempotency-Key). Never Authorization or Content-Type.
    headers?: Record<string, string>;
};

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

type ErrorData = { message: string | null; resetTime?: string; fieldErrors?: FieldError[]; code?: string; details?: Record<string, unknown> };
const isFieldError = (value: unknown): value is FieldError =>
    typeof (value as FieldError)?.field === "string" && typeof (value as FieldError)?.message === "string";
async function readErrorData(response: Response): Promise<ErrorData> {
    try {
        const data = (await response.json()) as { message?: unknown; resetTime?: unknown; errors?: unknown; code?: unknown; details?: unknown };
        const details = data?.details && typeof data.details === "object" && !Array.isArray(data.details) ? (data.details as Record<string, unknown>) : undefined;
        return {
            message: typeof data?.message === "string" && data.message.length <= 200 ? data.message : null,
            resetTime: typeof data?.resetTime === "string" ? data.resetTime : undefined,
            fieldErrors: Array.isArray(data?.errors) ? data.errors.filter(isFieldError).slice(0, 50) : [],
            code: typeof data?.code === "string" && /^[A-Z_]{1,64}$/.test(data.code) ? data.code : undefined,
            details,
        };
    } catch {
        return { message: null };
    }
}

export async function apiRequest<T>(path: string, { method = "GET", body, signal, token, headers: extraHeaders }: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { ...extraHeaders, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const effectiveToken = authorizationToken(token);
    if (effectiveToken) {
        headers["Authorization"] = `Bearer ${effectiveToken}`;
    }

    let response: Response;
    try {
        response = await fetch(path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            credentials: "omit",
            cache: "no-store",
            signal,
        });
    } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        throw new ApiError(0, "Cannot reach the server. Check your connection and try again.");
    }

    if (!response.ok) {
        const data = await readErrorData(response);
        const message = response.status >= 500 && response.status !== 502 ? FALLBACK_MESSAGE : data.message ?? FALLBACK_MESSAGE;
        throw new ApiError(response.status, message, data.resetTime ? new Date(data.resetTime) : undefined, response.status === 400 ? data.fieldErrors : [], data.code, data.details);
    }

    return (await response.json()) as T;
}

// A file sent straight to storage, to a signed upload URL the API issued for
// one object. The URL carries its own token, so no admin token or cookie is
// sent (the request leaves this origin), and the file never passes through
// the API.
export async function uploadToSignedUrl(url: string, file: File): Promise<void> {
    let response: Response;
    try {
        response = await fetch(url, { method: "PUT", headers: { "Content-Type": file.type }, body: file, credentials: "omit", cache: "no-store" });
    } catch {
        throw new ApiError(0, "The file could not be uploaded. Check your connection and try again.");
    }
    if (!response.ok) {
        const data = await readErrorData(response);
        const message = response.status === 413
            ? "The file is too large."
            : response.status >= 500 && response.status !== 502 ? FALLBACK_MESSAGE : data.message ?? FALLBACK_MESSAGE;
        throw new ApiError(response.status, message, data.resetTime ? new Date(data.resetTime) : undefined);
    }
}

// POST with a JSON body, answered by a file (a report). The file name comes from
// Content-Disposition (null when absent or unusable). Errors carry the server's
// message (4xx) like apiRequest; nothing from the body is logged.
export async function apiPostForFile(path: string, body: unknown, { signal, token }: Pick<RequestOptions, "signal" | "token"> = {}): Promise<{ blob: Blob; filename: string | null }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const effectiveToken = authorizationToken(token);
    if (effectiveToken) headers["Authorization"] = `Bearer ${effectiveToken}`;

    let response: Response;
    try {
        response = await fetch(path, { method: "POST", headers, body: JSON.stringify(body), credentials: "omit", cache: "no-store", signal });
    } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        throw new ApiError(0, "Cannot reach the server. Check your connection and try again.");
    }
    if (!response.ok) {
        const data = await readErrorData(response);
        const message = response.status >= 500 && response.status !== 502 ? FALLBACK_MESSAGE : data.message ?? FALLBACK_MESSAGE;
        throw new ApiError(response.status, message, data.resetTime ? new Date(data.resetTime) : undefined);
    }
    return { blob: await response.blob(), filename: filenameFromDisposition(response.headers.get("Content-Disposition")) };
}

// GET answered by a file (a stored file, a ZIP), with the file name from Content-Disposition. Unlike
// apiRequestBlob, errors keep the server's code (e.g. ZIP_TOO_LARGE) and its 502 message.
export async function apiGetForFile(path: string, { signal, token }: Pick<RequestOptions, "signal" | "token"> = {}): Promise<{ blob: Blob; filename: string | null }> {
    const headers: Record<string, string> = {};
    const effectiveToken = authorizationToken(token);
    if (effectiveToken) headers["Authorization"] = `Bearer ${effectiveToken}`;

    let response: Response;
    try {
        response = await fetch(path, { headers, credentials: "omit", cache: "no-store", signal });
    } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        throw new ApiError(0, "Cannot reach the server. Check your connection and try again.");
    }
    if (!response.ok) {
        const data = await readErrorData(response);
        const message = response.status >= 500 && response.status !== 502 ? FALLBACK_MESSAGE : data.message ?? FALLBACK_MESSAGE;
        throw new ApiError(response.status, message, data.resetTime ? new Date(data.resetTime) : undefined, [], data.code);
    }
    return { blob: await response.blob(), filename: filenameFromDisposition(response.headers.get("Content-Disposition")) };
}

function filenameFromDisposition(value: string | null): string | null {
    if (!value) return null;
    const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1];
    let name: string | undefined;
    if (encoded) {
        try { name = decodeURIComponent(encoded.trim()); } catch { name = undefined; }
    }
    name ??= /filename\s*=\s*"([^"]+)"/i.exec(value)?.[1] ?? /filename\s*=\s*([^;]+)/i.exec(value)?.[1]?.trim();
    // A bare file name only: no path, no control characters.
    const clean = name?.replace(/[\\/\u0000-\u001f]/g, "_").trim();
    return clean ? clean : null;
}

// Same rules as apiRequest, for a binary response (the review file preview).
export async function apiRequestBlob(path: string, { signal, token }: Pick<RequestOptions, "signal" | "token"> = {}): Promise<Blob> {
    const headers: Record<string, string> = {};
    const effectiveToken = authorizationToken(token);
    if (effectiveToken) {
        headers["Authorization"] = `Bearer ${effectiveToken}`;
    }

    let response: Response;
    try {
        response = await fetch(path, {
            headers,
            credentials: "omit",
            cache: "no-store",
            signal,
        });
    } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        throw new ApiError(0, "Cannot reach the server. Check your connection and try again.");
    }
    if (!response.ok) {
        const data = await readErrorData(response);
        const message = response.status >= 500 ? FALLBACK_MESSAGE : data.message ?? FALLBACK_MESSAGE;
        throw new ApiError(response.status, message, data.resetTime ? new Date(data.resetTime) : undefined);
    }
    return response.blob();
}
