import { ApiError, postJson } from "./client";
import type { VerifyRequest, VerifyResponse } from "../types/api";

const BASE = "/api/public/candidate-details";

// Passport Number + WhatsApp Number -> a short-lived candidate token.
export function verifyCandidate(input: VerifyRequest, signal?: AbortSignal): Promise<VerifyResponse> {
    return postJson<VerifyResponse>(`${BASE}/verify`, input, { signal });
}

// What a failed verification means for the candidate, so the page can show
// a fixed message in the chosen language. Never the server's raw text.
export type VerifyFailure = "failed" | "invalid" | "rateLimited" | "unavailable" | "network" | "generic";

export function verifyFailureOf(error: unknown): VerifyFailure {
    if (!(error instanceof ApiError)) return "generic";
    if (error.status === 0) return "network";
    if (error.status === 401) return "failed";
    if (error.status === 400 || error.status === 413) return "invalid";
    if (error.status === 429) return "rateLimited";
    // 403: this site's origin is not allowed (a configuration problem); 503:
    // the service is switched off or not configured. Neither is the candidate's doing.
    if (error.status === 403 || error.status === 503) return "unavailable";
    return "generic";
}
