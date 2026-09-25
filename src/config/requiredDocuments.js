// The documents every client must have (proposal §19): the passport, the
// final police report and a third document that the business can change.
// Set with REQUIRED_DOCUMENT_TYPES, a comma-separated list of document types:
//
//   REQUIRED_DOCUMENT_TYPES=PASSPORT,POLICE_REPORT,MEDICAL   (the default)
//
// Only real document types are accepted. An unknown type, UNKNOWN, a
// duplicate or an empty list is an error: the server refuses to start
// (src/config/env.js) instead of quietly using a different set.

import { DOCUMENT_TYPES } from "../services/documentClassificationService.js";

export const DEFAULT_REQUIRED_DOCUMENT_TYPES = Object.freeze([
    DOCUMENT_TYPES.PASSPORT,
    DOCUMENT_TYPES.POLICE_REPORT,
    DOCUMENT_TYPES.MEDICAL,
]);

// UNKNOWN is what the pipeline records when it can't tell; it can't be required.
export const REQUIRABLE_DOCUMENT_TYPES = Object.freeze(
    Object.values(DOCUMENT_TYPES).filter((type) => type !== DOCUMENT_TYPES.UNKNOWN)
);

// Returns { types } or { error }. Unset or blank means the default set.
// Case and spaces around the names don't matter ("passport, medical").
export function parseRequiredDocumentTypes(value) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return { types: DEFAULT_REQUIRED_DOCUMENT_TYPES };
    }
    const names = String(value).split(",").map((name) => name.trim().toUpperCase());
    if (names.some((name) => name === "")) {
        return { error: "REQUIRED_DOCUMENT_TYPES has an empty entry" };
    }
    const unknown = names.filter((name) => !REQUIRABLE_DOCUMENT_TYPES.includes(name));
    if (unknown.length) {
        // Only the allowed names are listed; the configured text is not echoed.
        return { error: `REQUIRED_DOCUMENT_TYPES may only contain ${REQUIRABLE_DOCUMENT_TYPES.join(", ")}` };
    }
    if (new Set(names).size !== names.length) {
        return { error: "REQUIRED_DOCUMENT_TYPES lists a document type twice" };
    }
    if (!names.includes(DOCUMENT_TYPES.PASSPORT)) {
        // The passport identifies the client (proposal §6, §19).
        return { error: "REQUIRED_DOCUMENT_TYPES must include PASSPORT" };
    }
    return { types: Object.freeze(names) };
}

// The configured set; throws on an invalid value (the startup check reports
// it first with the other settings).
export function loadRequiredDocumentTypes(env = process.env) {
    const { types, error } = parseRequiredDocumentTypes(env.REQUIRED_DOCUMENT_TYPES);
    if (error) throw new Error(error);
    return types;
}
