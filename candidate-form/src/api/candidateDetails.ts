import { ApiError, postJson } from "./client";
import type { CandidateFormPayload, FormLoadResponse, SubmitResponse, VerifyRequest, VerifyResponse } from "../types/api";

const BASE = "/api/public/candidate-details";

// Share-link secret + Passport Number + NIC -> a short-lived candidate token.
export function verifyCandidate(input: VerifyRequest, signal?: AbortSignal): Promise<VerifyResponse> {
    return postJson<VerifyResponse>(`${BASE}/verify`, input, { signal });
}

// The verified candidate's identity (read-only) and the prefill.
export function loadCandidateForm(token: string, signal?: AbortSignal): Promise<FormLoadResponse> {
    return postJson<FormLoadResponse>(`${BASE}/form`, {}, { token, signal });
}

// The answers, once. A retry of the same submission must reuse the same key.
export function submitCandidateForm(token: string, answers: CandidateFormPayload, idempotencyKey: string): Promise<SubmitResponse> {
    return postJson<SubmitResponse>(`${BASE}/submit`, { answers, idempotencyKey }, { token });
}

// What a failed verification means for the candidate, so the page can show
// a fixed message in the chosen language. Never the server's raw text.
export type VerifyFailure = "failed" | "invalid" | "rateLimited" | "unavailable" | "network" | "generic" | "submitted";

export function verifyFailureOf(error: unknown): VerifyFailure {
    if (!(error instanceof ApiError)) return "generic";
    if (error.status === 0) return "network";
    if (error.status === 401) return "failed";
    // Only after the link, passport and NIC all matched.
    if (error.status === 409 && error.code === "ALREADY_SUBMITTED") return "submitted";
    if (error.status === 400 || error.status === 413) return "invalid";
    if (error.status === 429) return "rateLimited";
    // 403: this site's origin is not allowed (a configuration problem); 503:
    // the service is switched off or not configured. Neither is the candidate's doing.
    if (error.status === 403 || error.status === 503) return "unavailable";
    return "generic";
}
