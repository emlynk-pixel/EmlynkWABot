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
