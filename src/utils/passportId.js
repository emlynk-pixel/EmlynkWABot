// Passport numbers are compared in one canonical form: uppercase, with no
// spaces, hyphens or MRZ filler. Returns null for values that can't be a
// passport number, so a bad OCR read never reaches a database lookup.
export function normalizePassportId(value) {
    if (!value) return null;

    const normalized = String(value).toUpperCase().replace(/[\s<-]/g, "");

    // ICAO allows up to 9 characters. Real numbers always contain a digit.
    const looksValid = /^[A-Z0-9]{6,9}$/.test(normalized) && /\d/.test(normalized);

    return looksValid ? normalized : null;
}

// A NEW candidate's own passport number (registration): exactly one letter, P or N, then exactly 7
// digits (P1234567, N1234567). Surrounding spaces are trimmed and lowercase p / n is accepted and
// stored in capitals; anything else (PN1234567, A1234567, P 1234567, P123456, ...) is refused.
// Only for passport numbers being SET: lookups (normalizePassportId above, the Candidate Form
// verification, search, document linking) stay permissive, because older candidates' numbers
// predate this rule and must keep working. The admin form has the same rule
// (admin/src/components/validation.ts).
export const CANDIDATE_PASSPORT_PATTERN = /^[PN][0-9]{7}$/;
export const CANDIDATE_PASSPORT_MESSAGE = "must start with P or N followed by 7 digits (e.g. P1234567)";
export function parseCandidatePassportNumber(value) {
    if (typeof value !== "string") return null;
    const candidate = value.trim().toUpperCase();
    return CANDIDATE_PASSPORT_PATTERN.test(candidate) ? candidate : null;
}

