// The keys of the import change ledger (candidateImportLedger.js): a keyed HMAC-SHA256 for the personal
// values a ledger entry has to compare later ("is the current value still what the import wrote?").
//
// Why a key: a plain SHA-256 of a predictable value (a NIC, a phone number, a date of birth) can be reversed
// by trying every possible value. An HMAC under a secret that is NOT in the database cannot be, by anyone who
// only holds the ledger (a database dump, a backup, a read-only role). The comparison a rollback needs still
// works: the server recomputes the HMAC of the current value with the same key.
//
// Configuration (server only, never in the admin console, never in a log, never in an error message):
//   IMPORT_LEDGER_HMAC_SECRET              the current secret: at least 32 characters, random
//   IMPORT_LEDGER_HMAC_KEY_ID              its id, [A-Za-z0-9_-]{1,32}; default "k1"
//   IMPORT_LEDGER_HMAC_SECRET_PREVIOUS     (rotation) the secret that was current before; entries signed with it
//   IMPORT_LEDGER_HMAC_KEY_ID_PREVIOUS     stay verifiable. Required together, with an id different from the current
//                                          one. Entries are re-signed with the current key by rekeyImportLedger.
// Every HMAC an entry stores carries the id of the key that made it ({ m, k, h }), so a rotation never
// makes an old entry unreadable, and a missing key is reported (KEY_UNAVAILABLE) instead of guessed.
//
// There is NO fallback: when the current secret is missing or invalid, readLedgerKeyring throws and the import
// refuses to write anything (an import that cannot be reversed safely is not started). It never degrades to a
// plain SHA-256.

import crypto from "node:crypto";
import { inspect } from "node:util";

export const HMAC_METHOD = "hmac-sha256";
export const MIN_SECRET_LENGTH = 32;
export const DEFAULT_KEY_ID = "k1";
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const DOMAIN = "emlynk-import-ledger-v1";

export class LedgerKeyConfigError extends Error {
    // problems: codes only (MISSING_SECRET, SECRET_TOO_SHORT, INVALID_KEY_ID, ...), never a value.
    constructor(problems) {
        super(`The import change-ledger key is not configured correctly (${problems.join(", ")}).`);
        this.name = "LedgerKeyConfigError";
        this.code = "LEDGER_KEY_NOT_CONFIGURED";
        this.problems = problems;
    }
}

const secretOf = new WeakMap();

// The loaded keys. The secrets live in a WeakMap, not on the object: JSON.stringify, console.log, util.inspect
// and spreading it show only the ids.
export class LedgerKeyring {
    constructor({ current, previous = [] }) {
        secretOf.set(this, new Map([current, ...previous].map((key) => [key.id, key.secret])));
        this.currentId = current.id;
        this.previousIds = previous.map((key) => key.id);
    }

    has(keyId) { return secretOf.get(this).has(keyId); }

    // The HMAC (hex) of `message` under the key `keyId`, or null when this key is not loaded.
    hmac(keyId, message) {
        const secret = secretOf.get(this).get(keyId);
        return secret === undefined ? null : crypto.createHmac("sha256", secret).update(message).digest("hex");
    }

    // { m, k, h } for a personal value of one ledger entry. ctx binds the value to its entry (import, entity
    // type, entity key) so the same value in two entries gives two different digests.
    digest(field, canonical, ctx, keyId = this.currentId) {
        return { m: HMAC_METHOD, k: keyId, h: this.hmac(keyId, hmacMessage(field, canonical, ctx)) };
    }

    toJSON() { return { currentId: this.currentId, previousIds: this.previousIds }; }
    [inspect.custom]() { return `LedgerKeyring { currentId: ${this.currentId}, previousIds: [${this.previousIds.join(", ")}] }`; }
}

export const hmacMessage = (field, canonical, ctx) => [DOMAIN, ctx, field, canonical].join("\u0000");

// env -> LedgerKeyring, or throws LedgerKeyConfigError listing the problems (codes only).
export function readLedgerKeyring(env = process.env) {
    const problems = [];
    const secret = env.IMPORT_LEDGER_HMAC_SECRET ?? "";
    const id = env.IMPORT_LEDGER_HMAC_KEY_ID?.trim() || DEFAULT_KEY_ID;
    if (!secret) problems.push("MISSING_SECRET");
    else if (secret.length < MIN_SECRET_LENGTH) problems.push("SECRET_TOO_SHORT");
    if (!KEY_ID.test(id)) problems.push("INVALID_KEY_ID");

    const previousSecret = env.IMPORT_LEDGER_HMAC_SECRET_PREVIOUS ?? "";
    const previousId = env.IMPORT_LEDGER_HMAC_KEY_ID_PREVIOUS?.trim() ?? "";
    const previous = [];
    if (previousSecret || previousId) {
        if (!previousSecret) problems.push("PREVIOUS_SECRET_MISSING");
        else if (previousSecret.length < MIN_SECRET_LENGTH) problems.push("PREVIOUS_SECRET_TOO_SHORT");
        if (!KEY_ID.test(previousId)) problems.push("PREVIOUS_KEY_ID_INVALID");
        else if (previousId === id) problems.push("PREVIOUS_KEY_ID_SAME_AS_CURRENT");
        if (previousSecret && previousSecret === secret) problems.push("PREVIOUS_SECRET_SAME_AS_CURRENT");
        if (!problems.some((p) => p.startsWith("PREVIOUS_"))) previous.push({ id: previousId, secret: previousSecret });
    }
    if (problems.length) throw new LedgerKeyConfigError(problems);
    return new LedgerKeyring({ current: { id, secret }, previous });
}
