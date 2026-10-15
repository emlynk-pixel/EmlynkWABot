import { safeEqual } from "./candidateFormTokenService.js";
import { normalizePhoneNumber } from "../utils/phoneNumber.js";

// Passport + WhatsApp verification for the Candidate Extra Details public
// form (POST /api/public/candidate-details/verify).
//
// Strict input rules come FIRST, before any database lookup:
//   - passportNumber: trimmed, spaces and hyphens removed, then letters and
//     digits only, 1-20 characters (the same pattern the staff routes use
//     before resolveCandidatePassportId). No prefix is required. Anything else
//     (including % and _, which the case-insensitive lookup would treat as
//     wildcards, and SQL-like text) is a 400 and never reaches the database.
//   - whatsappNumber: "+" then 8-15 digits, first digit not 0. Compared as
//     those digits; the input is NOT run through the Sri Lankan local-form
//     expansion of normalizePhoneNumber (that would let "+771234567" match a
//     stored "+94771234567"). The STORED number is normalised, so stored
//     "+94…", "94…" or "07…" forms all match "+94…".
//
// A match needs both values to belong to the same existing candidate. Every
// mismatch is the same generic result; the caller never learns which value
// was wrong or whether either exists.
//
// Timing: every syntactically valid request makes exactly ONE candidate query
// (the same query shape whether or not the passport exists) and always runs
// the same normalise-and-compare step, against a placeholder number when no
// candidate matched. So "passport not found" and "wrong WhatsApp" do the same
// database and comparison work. What remains is the database's own
// difference between returning zero rows and one row (sub-millisecond, far
// below network jitter), and the rate limits bound the number of attempts.

export const VERIFY_FAILED_MESSAGE = "We couldn't verify your details. Please check your Passport Number and WhatsApp Number and try again.";

const ALLOWED_FIELDS = new Set(["passportNumber", "whatsappNumber"]);
const PASSPORT_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const WHATSAPP_PATTERN = /^\+[1-9]\d{7,14}$/;
const MAX_RAW_LENGTH = 64;

// { values: { passportId, whatsappDigits } } or { errors: [{ field, message }] }.
// Messages never echo the submitted values.
export function parseVerifyBody(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { errors: [{ field: "body", message: "must be a JSON object" }] };
    }
    const errors = [];
    if (Object.keys(body).some((key) => !ALLOWED_FIELDS.has(key))) {
        errors.push({ field: "body", message: "contains unsupported fields" });
    }

    let passportId = null;
    const passport = body.passportNumber;
    if (passport === undefined || passport === null || (typeof passport === "string" && passport.trim() === "")) {
        errors.push({ field: "passportNumber", message: "is required" });
    } else if (typeof passport !== "string" || passport.length > MAX_RAW_LENGTH) {
        errors.push({ field: "passportNumber", message: "must contain only letters and digits (at most 20)" });
    } else {
        const canonical = passport.trim().replace(/[\s-]/g, "");
        if (PASSPORT_PATTERN.test(canonical)) passportId = canonical;
        else errors.push({ field: "passportNumber", message: "must contain only letters and digits (at most 20)" });
    }

    let whatsappDigits = null;
    const whatsapp = body.whatsappNumber;
    if (whatsapp === undefined || whatsapp === null || (typeof whatsapp === "string" && whatsapp.trim() === "")) {
        errors.push({ field: "whatsappNumber", message: "is required" });
    } else if (typeof whatsapp !== "string" || whatsapp.length > MAX_RAW_LENGTH || !WHATSAPP_PATTERN.test(whatsapp.trim())) {
        errors.push({ field: "whatsappNumber", message: "must start with + followed by 8 to 15 digits" });
    } else {
        whatsappDigits = whatsapp.trim().slice(1);
    }

    return errors.length ? { errors } : { values: { passportId, whatsappDigits } };
}

// Case variants of one passport that a lookup reads at most (legacy rows may
// differ only by case; more than one variant without an exact match is
// ambiguous and never verifies).
const MAX_CASE_VARIANTS = 10;

// Compared when no candidate matched, so the mismatch paths do the same work.
// It can never equal a valid input (inputs never start with 0).
const NO_MATCH_STORED_NUMBER = "+0000000000";

// The matched candidate { passportId, whatsappDigits } (stored passport ID,
// normalised stored number), or null. Inputs must come from parseVerifyBody:
// the passport is letters and digits only, so no LIKE wildcard can reach the
// case-insensitive match below.
export async function verifyCandidateDetailsAccess({ db, passportId, whatsappDigits }) {
    // One query on every path: all case variants of the passport, with their numbers.
    const rows = await db.candidate.findMany({
        where: { passportId: { equals: passportId, mode: "insensitive" } },
        select: { passportId: true, whatsappNumber: true },
        take: MAX_CASE_VARIANTS,
    });
    // The rule of resolveCandidatePassportId (candidateService.js): the exact
    // row, else the single case-insensitive match; never a guess between rows.
    const candidate = rows.find((row) => row.passportId === passportId) ?? (rows.length === 1 ? rows[0] : null);

    // Always normalise and compare, whether or not a candidate matched.
    const storedDigits = normalizePhoneNumber(candidate ? candidate.whatsappNumber : NO_MATCH_STORED_NUMBER);
    const numbersMatch = safeEqual(storedDigits ?? "", whatsappDigits);
    if (!candidate || !storedDigits || !numbersMatch) return null;
    return { passportId: candidate.passportId, whatsappDigits: storedDigits };
}
