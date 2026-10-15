import crypto from "node:crypto";

import { isUsableTokenSecret } from "../config/candidateForm.js";

// Short-lived candidate token for the Candidate Extra Details public form.
//
// Issued only by POST /api/public/candidate-details/verify after Passport +
// WhatsApp matched one existing candidate. It is a credential of a different
// kind from a staff session and must never be confused with one:
//
//   - Format "cf1~<iv>~<ciphertext>": NOT shaped like a JWT (no dots), so the
//     staff verifier (src/auth/supabaseIdentity.js) rejects it by shape before
//     any Supabase call, and no admin route can accept it.
//   - AES-256-GCM (node:crypto): the payload is encrypted AND authenticated,
//     so a modified token fails, and the candidate's passport ID is not
//     readable from the token in the browser.
//   - Keys are derived (HKDF) from CANDIDATE_FORM_TOKEN_SECRET, backend only.
//   - Payload: version, audience, candidate passport ID, a keyed hash of the
//     candidate's stored WhatsApp number (the binding), issued / expiry times.
//     Expiry 15 minutes; a token claiming a longer life is refused.
//   - The binding is re-checked against the database on every use
//     (src/middleware/requireCandidateFormToken.js), so a token stops working
//     as soon as the stored WhatsApp number changes.
//
// Nothing is stored server-side.

export const CANDIDATE_FORM_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_LIFETIME_SECONDS = CANDIDATE_FORM_TOKEN_TTL_MS / 1000;
const CLOCK_SKEW_SECONDS = 60;
const PREFIX = "cf1";
const SEPARATOR = "~";
const AUDIENCE = "candidate-form";
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_LENGTH = 1024;
const B64URL = /^[A-Za-z0-9_-]+$/;
const PASSPORT_ID = /^[A-Za-z0-9]{1,20}$/;

function subKey(secret, purpose) {
    return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("emlynk-candidate-form"), Buffer.from(purpose), 32));
}

const hmac = (secret, purpose, value) => crypto.createHmac("sha256", subKey(secret, purpose)).update(value).digest("base64url");

// Keyed hash of the normalised WhatsApp digits (the token's binding).
export const whatsappBinding = (secret, whatsappDigits) => hmac(secret, "whatsapp-binding", whatsappDigits);

// Keyed hash of a canonical passport number: the per-passport rate-limit key
// and a log reference. Upper case, because the lookup is case-insensitive.
export const passportReference = (secret, passportId) => hmac(secret, "passport-reference", passportId.toUpperCase());

// Constant-time comparison of two strings.
export function safeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// { token, expiresAt } for one verified candidate.
export function issueCandidateFormToken({ secret, passportId, whatsappDigits, now = new Date(), ttlMs = CANDIDATE_FORM_TOKEN_TTL_MS }) {
    if (!isUsableTokenSecret(secret)) throw new Error("CANDIDATE_FORM_TOKEN_SECRET is not configured");
    if (!PASSPORT_ID.test(passportId ?? "") || typeof whatsappDigits !== "string" || whatsappDigits === "") throw new Error("Invalid token subject");
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + Math.min(Math.floor(ttlMs / 1000), MAX_LIFETIME_SECONDS);
    const payload = Buffer.from(JSON.stringify({ v: VERSION, aud: AUDIENCE, sub: passportId, wa: whatsappBinding(secret, whatsappDigits), iat, exp }));

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", subKey(secret, "token-encryption"), iv);
    cipher.setAAD(Buffer.from(PREFIX));
    const sealed = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
    return {
        token: [PREFIX, iv.toString("base64url"), sealed.toString("base64url")].join(SEPARATOR),
        expiresAt: new Date(exp * 1000).toISOString(),
    };
}

// The verified payload { sub, wa, iat, exp }, or null for anything that is not
// a valid, unexpired token of this service (never throws).
export function readCandidateFormToken(token, { secret, now = new Date() } = {}) {
    if (!isUsableTokenSecret(secret)) return null;
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    const parts = token.split(SEPARATOR);
    if (parts.length !== 3 || parts[0] !== PREFIX || !B64URL.test(parts[1]) || !B64URL.test(parts[2])) return null;
    const iv = Buffer.from(parts[1], "base64url");
    const sealed = Buffer.from(parts[2], "base64url");
    if (iv.length !== IV_BYTES || sealed.length <= TAG_BYTES) return null;

    let payload;
    try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", subKey(secret, "token-encryption"), iv);
        decipher.setAAD(Buffer.from(PREFIX));
        decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
        const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
        payload = JSON.parse(plain.toString("utf8"));
    } catch {
        return null;
    }

    const nowSeconds = Math.floor(now.getTime() / 1000);
    const valid = payload
        && payload.v === VERSION
        && payload.aud === AUDIENCE
        && typeof payload.sub === "string" && PASSPORT_ID.test(payload.sub)
        && typeof payload.wa === "string" && payload.wa.length > 0
        && Number.isInteger(payload.iat) && Number.isInteger(payload.exp)
        && payload.iat <= nowSeconds + CLOCK_SKEW_SECONDS
        && payload.exp > nowSeconds
        && payload.exp - payload.iat <= MAX_LIFETIME_SECONDS;
    return valid ? { sub: payload.sub, wa: payload.wa, iat: payload.iat, exp: payload.exp } : null;
}
