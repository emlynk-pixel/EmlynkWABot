// Sri Lanka. Used only for local-format Sri Lankan mobile numbers.
export const DEFAULT_COUNTRY_CODE = "94";

// Compare phone numbers as digits in international format without "+".
//   947XXXXXXXX     -> kept (Meta sends this format)
//   +947XXXXXXXX    -> 947XXXXXXXX
//   07XXXXXXXX      -> 947XXXXXXXX
//   7XXXXXXXX       -> 947XXXXXXXX (Excel dropped the leading zero)
// Anything that already carries a country code, or isn't a local mobile
// number, is compared as its digits with nothing added.
// Used for comparison only. Stored numbers are never rewritten.
export function normalizePhoneNumber(value) {
    if (value === null || value === undefined) return null;

    let digits = String(value).replace(/\D/g, "");

    // "00" is the international dialling prefix, same as "+".
    if (digits.startsWith("00")) {
        digits = digits.slice(2);
    }

    if (/^07\d{8}$/.test(digits)) {
        digits = DEFAULT_COUNTRY_CODE + digits.slice(1);
    } else if (/^7\d{8}$/.test(digits)) {
        // Exactly 9 digits can't include a country code, so this is safe.
        digits = DEFAULT_COUNTRY_CODE + digits;
    }

    // E.164 numbers are at most 15 digits.
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

// A candidate phone number has THREE forms; keep them apart:
//   storage     canonicalPhoneNumber -> "+94771234567"  (every new candidate write)
//   comparison  phoneKey             -> "94771234567"   (duplicates, lookups; any stored form)
//   display     the stored value as it is
// phoneKey is normalizePhoneNumber plus one rule: a Sri Lankan national number of 10 digits
// (0XXXXXXXXX, mobile or landline) is +94. The database's candidate_phone_key() function
// (migration 20261104120000) computes the SAME key for its normalized unique index.
export function phoneKey(value) {
    const digits = normalizePhoneNumber(value);
    if (digits && /^0\d{9}$/.test(digits)) return DEFAULT_COUNTRY_CODE + digits.slice(1);
    return digits;
}

// "+" and the key, or null when the number has no country code we can be sure of (a number
// still starting with 0 is a national number other than the Sri Lankan 10-digit form).
// A number that already carries a country code keeps it: Sri Lankan +94 is never forced on it.
export function canonicalPhoneNumber(value) {
    const key = phoneKey(value);
    return key && !key.startsWith("0") ? `+${key}` : null;
}

// The key two numbers are compared by in isSamePhoneNumber, never stored and never used for
// lookups (those use phoneKey, which must stay equal to the SQL candidate_phone_key()). At least as
// strict as the Candidate Form's samePhone (candidate-form/src/form/phone.ts): non-digits dropped,
// a leading "00" removed, then a Sri Lankan number is its 9 national digits however written:
//   94 + 9 digits, 940 + 9 digits ("+94 0771234567"), 0 + 9 digits, or the bare 9 digits.
// Any other number is its plain digits (no length limit, like the form). No digits at all is null.
export function samePhoneKey(value) {
    if (value === null || value === undefined) return null;
    let digits = String(value).replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (/^94\d{9}$/.test(digits)) digits = digits.slice(2);
    else if (/^940\d{9}$/.test(digits)) digits = digits.slice(3);
    else if (/^0\d{9}$/.test(digits)) digits = digits.slice(1);
    return digits || null;
}

// Whether two numbers are the same phone number in any of their written forms ("+94 77 123 4567",
// "0094771234567", "0771234567", "+94 0771234567", "771234567"). Not a number (empty, "N/A",
// unparseable) is never the same.
export function isSamePhoneNumber(a, b) {
    const key = samePhoneKey(a);
    return Boolean(key) && key === samePhoneKey(b);
}
