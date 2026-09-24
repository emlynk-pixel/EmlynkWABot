import { normalizePassportId } from "../utils/passportId.js";
import { normalizePhoneNumber } from "../utils/phoneNumber.js";

export const LOOKUP_STATUS = Object.freeze({
    FOUND: "FOUND",
    NOT_FOUND: "NOT_FOUND",
    MULTIPLE: "MULTIPLE",
    INVALID_INPUT: "INVALID_INPUT",
});

// Fields needed for identity decisions and passport reconciliation.
export const USER_LOOKUP_SELECT = Object.freeze({
    passportId: true,
    uniqueId: true,
    whatsappNumber: true,
    firstName: true,
    otherName: true,
    dateOfBirth: true,
    placeOfBirth: true,
    passportExpiryDate: true,
});

// Loaded lazily so unit tests can pass a fake client without touching the DB.
async function resolveDb(db) {
    return db ?? (await import("../config/prisma.js")).default;
}

function toResult(users) {
    if (users.length === 0) return { status: LOOKUP_STATUS.NOT_FOUND, users };
    if (users.length === 1) return { status: LOOKUP_STATUS.FOUND, users };
    return { status: LOOKUP_STATUS.MULTIPLE, users };
}

// users.passport_id is the primary key, so this is an exact match.
// It's case-insensitive in case legacy rows were stored in lowercase.
// unique_id is a different identifier and is never used here.
export async function findUsersByPassportId(passportId, { db } = {}) {
    const normalized = normalizePassportId(passportId);
    if (!normalized) return { status: LOOKUP_STATUS.INVALID_INPUT, users: [] };

    const client = await resolveDb(db);
    const users = await client.user.findMany({
        where: { passportId: { equals: normalized, mode: "insensitive" } },
        select: USER_LOOKUP_SELECT,
        take: 2,
    });

    return toResult(users);
}

// whatsapp_number isn't unique and its stored format varies, so narrow by
// the last four digits in the database, then compare the full normalized
// numbers here. More than one match is a real, reviewable case.
export async function findUsersByWhatsappNumber(whatsappNumber, { db } = {}) {
    const normalized = normalizePhoneNumber(whatsappNumber);
    if (!normalized) return { status: LOOKUP_STATUS.INVALID_INPUT, users: [] };

    const client = await resolveDb(db);
    const candidates = await client.user.findMany({
        where: { whatsappNumber: { endsWith: normalized.slice(-4) } },
        select: USER_LOOKUP_SELECT,
    });

    return toResult(
        candidates.filter((user) => normalizePhoneNumber(user.whatsappNumber) === normalized)
    );
}
