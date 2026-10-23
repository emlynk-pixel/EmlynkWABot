import { apiUrl } from "../config/env";
import type { ApiErrorBody, FieldError } from "../types/api";

// The form's only network client. It never sends cookies or credentials,
// never caches, sends no referrer, and puts nothing sensitive in a URL: the
// candidate token travels only in the Authorization header (Task 2).

export class ApiError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly fieldErrors: FieldError[];

    constructor(status: number, message: string, code?: string, fieldErrors: FieldError[] = []) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
        this.fieldErrors = fieldErrors;
    }
}

const NETWORK_MESSAGE = "We couldn't reach the server. Please check your connection and try again.";
const FALLBACK_MESSAGE = "Something went wrong. Please try again later.";

async function readBody(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

export async function postJson<T>(path: string, body: unknown, { token, signal }: { token?: string; signal?: AbortSignal } = {}): Promise<T> {
    let response: Response;
    try {
        response = await fetch(apiUrl(path), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(body),
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            mode: "cors",
            signal,
        });
    } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        throw new ApiError(0, NETWORK_MESSAGE);
    }

    const data = (await readBody(response)) as ApiErrorBody | T | null;
    if (!response.ok) {
        const errorBody = (data ?? {}) as ApiErrorBody;
        // The server's public messages are fixed and safe to show; anything else gets a generic text.
        const message = response.status < 500 && typeof errorBody.message === "string" ? errorBody.message : FALLBACK_MESSAGE;
        const fieldErrors = Array.isArray(errorBody.errors) ? errorBody.errors.filter((e) => typeof e?.field === "string" && typeof e?.message === "string") : [];
        throw new ApiError(response.status, message, typeof errorBody.code === "string" ? errorBody.code : undefined, fieldErrors);
    }
    return data as T;
}
