import { postJson } from "./client";
import type { VerifyRequest, VerifyResponse } from "../types/api";

const BASE = "/api/public/candidate-details";

// Passport Number + WhatsApp Number -> a short-lived candidate token.
export function verifyCandidate(input: VerifyRequest, signal?: AbortSignal): Promise<VerifyResponse> {
    return postJson<VerifyResponse>(`${BASE}/verify`, input, { signal });
}
