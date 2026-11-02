// Candidate phone numbers in the canonical storage form "+<country code><number>"
// (utils/phoneNumber.js canonicalPhoneNumber): a COUNT-ONLY analysis of the stored values, and a
// safe backfill of the older forms (scripts/auditCandidatePhones.mjs).
//
// Output holds counts, country-code tallies and candidates' internal unique IDs only; never a
// phone number, name or passport number.
//
// The backfill rewrites only what is safe:
//   - a value that can be canonicalized and differs from its canonical form;
//   - a WhatsApp number whose key no other candidate shares (a shared number is a CONFLICT the
//     staff resolve by hand: which candidate keeps it is a business decision, never guessed);
//   - not on a candidate whose details are verified: changing whatsapp_number / contact_number
//     clears that verification (migration 20261022120000), which a format change must not do;
//   - compare-and-swap: a row changed meanwhile is left alone.
// A value that can't be canonicalized is left exactly as it is and reported.
// Each rewrite queues the candidate for the Google Sheet mirror through the existing triggers.

import { canonicalPhoneNumber, phoneKey } from "../utils/phoneNumber.js";

// Shared on purpose before the unique index existed (migration 20261001140000).
export const EXEMPT_WHATSAPP_KEY = "94771581916";

const SELECT = { passportId: true, uniqueId: true, whatsappNumber: true, contactNumber: true, verification: { select: { detailsVerifiedAt: true } } };
const PAGE = 500;

async function* allCandidates(db) {
    let cursor = null;
    for (;;) {
        const page = await db.candidate.findMany({ select: SELECT, orderBy: { passportId: "asc" }, take: PAGE, ...(cursor ? { cursor: { passportId: cursor }, skip: 1 } : {}) });
        if (!page.length) return;
        yield* page;
        cursor = page.at(-1).passportId;
    }
}

const isBlank = (value) => value === null || value === undefined || String(value).trim() === "";
const countryBucket = (key) => (key.startsWith("94") ? "94 (Sri Lanka)" : key.startsWith("40") ? "40 (Romania)" : "other");

function emptyField() {
    return { total: 0, withPlus: 0, withoutPlus: 0, alreadyCanonical: 0, toCanonicalize: 0, cannotNormalize: 0, verifiedToCanonicalize: 0, countryCodes: {} };
}

// { whatsapp, contact, duplicateGroups, duplicateCandidates, conflicts: [[uniqueId...]], cannotNormalize: { whatsapp: [uniqueId], contact: [uniqueId] } }
export async function analyzeCandidatePhones(db) {
    const whatsapp = emptyField();
    const contact = emptyField();
    const byKey = new Map();
    const cannotNormalize = { whatsapp: [], contact: [] };
    for await (const candidate of allCandidates(db)) {
        const verified = Boolean(candidate.verification?.detailsVerifiedAt);
        for (const [stats, column, list] of [[whatsapp, "whatsappNumber", cannotNormalize.whatsapp], [contact, "contactNumber", cannotNormalize.contact]]) {
            const stored = candidate[column];
            if (isBlank(stored)) continue;
            stats.total += 1;
            if (String(stored).trim().startsWith("+")) stats.withPlus += 1;
            else stats.withoutPlus += 1;
            const canonical = canonicalPhoneNumber(stored);
            if (!canonical) { stats.cannotNormalize += 1; list.push(candidate.uniqueId); continue; }
            const bucket = countryBucket(canonical.slice(1));
            stats.countryCodes[bucket] = (stats.countryCodes[bucket] ?? 0) + 1;
            if (canonical === stored) stats.alreadyCanonical += 1;
            else {
                stats.toCanonicalize += 1;
                if (verified) stats.verifiedToCanonicalize += 1;
            }
            if (column === "whatsappNumber" && phoneKey(stored) !== EXEMPT_WHATSAPP_KEY) {
                const key = phoneKey(stored);
                if (!byKey.has(key)) byKey.set(key, []);
                byKey.get(key).push(candidate.uniqueId);
            }
        }
    }
    const conflicts = [...byKey.values()].filter((ids) => ids.length > 1).map((ids) => ids.sort());
    return {
        whatsapp, contact,
        duplicateGroups: conflicts.length, duplicateCandidates: conflicts.reduce((n, ids) => n + ids.length, 0),
        conflicts, cannotNormalize,
    };
}

// Rewrites the safe rows (see the top of this file). dryRun: count what would change, write nothing.
// Returns counts only.
export async function canonicalizeCandidatePhones(db, { dryRun = true } = {}) {
    const analysis = await analyzeCandidatePhones(db);
    const conflicted = new Set(analysis.conflicts.flat());
    const result = { dryRun, whatsappUpdated: 0, contactUpdated: 0, skippedVerified: 0, skippedConflict: 0, skippedCannotNormalize: analysis.whatsapp.cannotNormalize + analysis.contact.cannotNormalize, changedMeanwhile: 0 };
    for await (const candidate of allCandidates(db)) {
        const data = {};
        const whatsapp = canonicalPhoneNumber(candidate.whatsappNumber);
        if (!isBlank(candidate.whatsappNumber) && whatsapp && whatsapp !== candidate.whatsappNumber) {
            if (conflicted.has(candidate.uniqueId)) result.skippedConflict += 1;
            else data.whatsappNumber = whatsapp;
        }
        const contact = canonicalPhoneNumber(candidate.contactNumber);
        if (!isBlank(candidate.contactNumber) && contact && contact !== candidate.contactNumber) data.contactNumber = contact;
        if (!Object.keys(data).length) continue;
        if (candidate.verification?.detailsVerifiedAt) { result.skippedVerified += 1; continue; }
        if (!dryRun) {
            const { count } = await db.candidate.updateMany({
                where: { passportId: candidate.passportId, whatsappNumber: candidate.whatsappNumber, contactNumber: candidate.contactNumber },
                data,
            });
            if (count !== 1) { result.changedMeanwhile += 1; continue; }
        }
        if (data.whatsappNumber) result.whatsappUpdated += 1;
        if (data.contactNumber) result.contactUpdated += 1;
    }
    return result;
}
