// Minimal JSON client for the EmlynkWABot backend. Requests are same-origin:
// in production Express serves this app, in development Vite proxies /auth.

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
    token?: string | null;
    signal?: AbortSignal;
};

// Only the backend's own short, generic messages are shown to the user
// (e.g. "Invalid email or password"). Anything unexpected gets a fixed text.
const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

async function readMessage(response: Response): Promise<string | null> {
    try {
        const data = (await response.json()) as { message?: unknown };
        return typeof data?.message === "string" && data.message.length <= 200 ? data.message : null;
    } catch {
        return null;
    }
}

export async function apiRequest<T>(path: string, { method = "GET", body, token, signal }: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    let response: Response;
    try {
        response = await fetch(path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            credentials: "same-origin",
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

    return (await response.json()) as T;
}
