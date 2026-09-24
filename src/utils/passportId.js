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
