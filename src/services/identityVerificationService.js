import { LOOKUP_STATUS } from "./userLookupService.js";
import { CONFIDENCE_THRESHOLDS } from "./confidenceService.js";

// Proposal §13. WhatsApp is only a signal; the passport ID is the identity.
// Nothing here merges users or changes stored data.
export const IDENTITY_STATUS = Object.freeze({
    VERIFIED_MATCH: "VERIFIED_MATCH",                 // A: passport + WhatsApp -> same user
    PASSPORT_MATCH_ONLY: "PASSPORT_MATCH_ONLY",       // C / E: passport user found, WhatsApp differs or missing
    WHATSAPP_MATCH_ONLY: "WHATSAPP_MATCH_ONLY",       // D, and non-passport documents
    IDENTITY_CONFLICT: "IDENTITY_CONFLICT",           // B: passport and WhatsApp -> different users
    NO_MATCH: "NO_MATCH",                             // F
    PASSPORT_ID_UNRESOLVED: "PASSPORT_ID_UNRESOLVED", // G: passport unreadable
    AMBIGUOUS_MATCH: "AMBIGUOUS_MATCH",               // H: more than one candidate
});

export const IDENTITY_NOTES = Object.freeze({
    WHATSAPP_NOT_ON_RECORD: "WHATSAPP_NOT_ON_RECORD",
    WHATSAPP_DIFFERS: "WHATSAPP_DIFFERS",
    PASSPORT_NOT_IN_DATABASE: "PASSPORT_NOT_IN_DATABASE",
    PASSPORT_ID_LOW_CONFIDENCE: "PASSPORT_ID_LOW_CONFIDENCE",
});

// A passport number below this is too unreliable to identify anyone.
export const MIN_PASSPORT_ID_CONFIDENCE = CONFIDENCE_THRESHOLDS.SLIGHTLY_UNCLEAR_FROM;

// Only IDs go into the result, never names or other personal fields.
const idsOf = (lookup) =>
    (lookup?.users ?? []).map(({ passportId, uniqueId }) => ({ passportId, uniqueId }));

function decision(status, { user = null, reviewRequired, provisional = false, notes = [], passportLookup, whatsappLookup }) {
    return {
        status,
        passportId: user?.passportId ?? null,
        uniqueId: user?.uniqueId ?? null,
        reviewRequired,
        provisional,
        notes,
        candidates: {
            byPassport: idsOf(passportLookup),
            byWhatsapp: idsOf(whatsappLookup),
        },
    };
}

// Decide who sent the document.
// - isPassportDocument: the document itself was classified as a passport
// - passportIdConfidence: field confidence of the extracted passport number
// - passportLookup / whatsappLookup: results from userLookupService
export function decideIdentity({ isPassportDocument, passportIdConfidence = 0, passportLookup, whatsappLookup }) {
    const context = { passportLookup, whatsappLookup };
    const whatsappStatus = whatsappLookup?.status ?? LOOKUP_STATUS.NOT_FOUND;
    const whatsappUser = whatsappStatus === LOOKUP_STATUS.FOUND ? whatsappLookup.users[0] : null;

    // Police/medical documents carry no passport. The WhatsApp number is
    // the only identity signal (§13: "Existing WhatsApp identity trusted?").
    if (!isPassportDocument) {
        if (whatsappStatus === LOOKUP_STATUS.MULTIPLE) {
            return decision(IDENTITY_STATUS.AMBIGUOUS_MATCH, { ...context, reviewRequired: true });
        }
        if (whatsappUser) {
            return decision(IDENTITY_STATUS.WHATSAPP_MATCH_ONLY, { ...context, user: whatsappUser, reviewRequired: false });
        }
        return decision(IDENTITY_STATUS.NO_MATCH, { ...context, reviewRequired: true });
    }

    const passportUnreadable =
        !passportLookup ||
        passportLookup.status === LOOKUP_STATUS.INVALID_INPUT ||
        passportIdConfidence < MIN_PASSPORT_ID_CONFIDENCE;

    // G: we can't trust the passport number. A WhatsApp match is kept only
    // as a provisional candidate for the reviewer.
    if (passportUnreadable) {
        const notes = passportLookup && passportLookup.status !== LOOKUP_STATUS.INVALID_INPUT
            ? [IDENTITY_NOTES.PASSPORT_ID_LOW_CONFIDENCE]
            : [];
        return decision(IDENTITY_STATUS.PASSPORT_ID_UNRESOLVED, {
            ...context,
            user: whatsappUser,
            provisional: Boolean(whatsappUser),
            reviewRequired: true,
            notes,
        });
    }

    // H: never pick one of several candidates silently.
    if (passportLookup.status === LOOKUP_STATUS.MULTIPLE || whatsappStatus === LOOKUP_STATUS.MULTIPLE) {
        return decision(IDENTITY_STATUS.AMBIGUOUS_MATCH, { ...context, reviewRequired: true });
    }

    const passportUser = passportLookup.status === LOOKUP_STATUS.FOUND ? passportLookup.users[0] : null;

    if (passportUser && whatsappUser) {
        // A: same person.
        if (passportUser.passportId === whatsappUser.passportId) {
            return decision(IDENTITY_STATUS.VERIFIED_MATCH, { ...context, user: passportUser, reviewRequired: false });
        }
        // B: WhatsApp belongs to someone else. Never merge.
        return decision(IDENTITY_STATUS.IDENTITY_CONFLICT, { ...context, reviewRequired: true });
    }

    if (passportUser) {
        // E: no WhatsApp on record; associate by passport, don't fill WhatsApp.
        // C: the record has a different WhatsApp; don't change it, flag it.
        // Both need review (SEC-008): a passport number alone doesn't prove
        // the sender is the client, since anyone holding a copy of the
        // passport could send it. The document stays linked to the passport
        // (§13 E) but goes to pending/{unique_id} until a person confirms it.
        const whatsappMissing = !passportUser.whatsappNumber;
        return decision(IDENTITY_STATUS.PASSPORT_MATCH_ONLY, {
            ...context,
            user: passportUser,
            reviewRequired: true,
            notes: [whatsappMissing ? IDENTITY_NOTES.WHATSAPP_NOT_ON_RECORD : IDENTITY_NOTES.WHATSAPP_DIFFERS],
        });
    }

    if (whatsappUser) {
        // D: known WhatsApp, but this passport isn't in the database.
        // The link stays provisional until someone verifies it.
        return decision(IDENTITY_STATUS.WHATSAPP_MATCH_ONLY, {
            ...context,
            user: whatsappUser,
            provisional: true,
            reviewRequired: true,
            notes: [IDENTITY_NOTES.PASSPORT_NOT_IN_DATABASE],
        });
    }

    // F: neither identifies the client.
    return decision(IDENTITY_STATUS.NO_MATCH, {
        ...context,
        reviewRequired: true,
        notes: [IDENTITY_NOTES.PASSPORT_NOT_IN_DATABASE],
    });
}
