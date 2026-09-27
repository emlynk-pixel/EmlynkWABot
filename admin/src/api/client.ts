// Minimal JSON client for the EmlynkWABot backend. Requests are same-origin:
// in production Express serves this app, in development Vite proxies /auth and /api.
//
// Phase 12: authentication is via an httpOnly cookie set by the server.
// All requests send credentials: "include" so the browser attaches the cookie.
// When an explicit token or stored test token is present, Authorization: Bearer
// is also included for backward compatibility with existing tests and CLI tools.

import { readToken } from "../auth/tokenStorage";

export class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

type RequestOptions = {
    method?: "GET" | "POST";
    body?: unknown;
    signal?: AbortSignal;
    token?: string;
};

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

async function readMessage(response: Response): Promise<string | null> {
    try {
        const data = (await response.json()) as { message?: unknown };
        return typeof data?.message === "string" && data.message.length <= 200 ? data.message : null;
    } catch {
        return null;
    }
}

export async function apiRequest<T>(path: string, { method = "GET", body, signal, token }: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const explicitToken = token && token !== "session" && token !== "cookie" ? token : null;
    const effectiveToken = explicitToken ?? readToken();
    if (effectiveToken) {
        headers["Authorization"] = `Bearer ${effectiveToken}`;
    }

    let response: Response;
    try {
        response = await fetch(path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            credentials: "include",
            cache: "no-store",
            signal,
        });
    } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        throw new ApiError(0, "Cannot reach the server. Check your connection and try again.");
    }

    if (!response.ok) {
        const message = response.status >= 500 && response.status !== 502 ? FALLBACK_MESSAGE : (await readMessage(response)) ?? FALLBACK_MESSAGE;
        throw new ApiError(response.status, message);
    }

    return (await response.json()) as T;
}

// Same rules as apiRequest, for a binary response (the review file preview).
export async function apiRequestBlob(path: string, { signal, token }: Pick<RequestOptions, "signal" | "token"> = {}): Promise<Blob> {
    const headers: Record<string, string> = {};
    const explicitToken = token && token !== "session" && token !== "cookie" ? token : null;
    const effectiveToken = explicitToken ?? readToken();
    if (effectiveToken) {
        headers["Authorization"] = `Bearer ${effectiveToken}`;
    }

    let response: Response;
    try {
        response = await fetch(path, {
            headers,
            credentials: "include",
            cache: "no-store",
            signal,
        });
    } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        throw new ApiError(0, "Cannot reach the server. Check your connection and try again.");
    }
    if (!response.ok) {
        const message = response.status >= 500 ? FALLBACK_MESSAGE : (await readMessage(response)) ?? FALLBACK_MESSAGE;
        throw new ApiError(response.status, message);
    }
    return response.blob();
}
