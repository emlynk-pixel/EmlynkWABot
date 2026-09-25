// Storage paths and file names for Phase 7 (proposal §15, §16, §25).
// Pure functions: no Supabase or database access here.

// Folder and standard base name per document type (proposal §15).
export const DOCUMENT_STORAGE_TYPES = Object.freeze({
    PASSPORT: { folder: "passport", baseName: "passport" },
    POLICE_SLIP: { folder: "police-slip", baseName: "police_slip" },
    POLICE_REPORT: { folder: "police-report", baseName: "police_report" },
    MEDICAL: { folder: "medical", baseName: "medical" },
});

// The extension always comes from the validated MIME type, never from the
// sender's file name ("scan.exe" sent as a PDF is stored as .pdf).
const EXTENSION_BY_MIME_TYPE = new Map([
    ["application/pdf", ".pdf"],
    ["image/jpeg", ".jpeg"],
    ["image/png", ".png"],
]);

const MAX_BASE_NAME_LENGTH = 100;

export function extensionForMimeType(mimeType) {
    const extension = EXTENSION_BY_MIME_TYPE.get(mimeType);
    if (!extension) {
        throw new Error(`No storage extension for MIME type ${mimeType}`);
    }
    return extension;
}

// Path segments built from IDs must never contain "/" or "..".
function assertSafeSegment(value, label) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error(`Unsafe ${label} for a storage path`);
    }
    return value;
}

// clients/{passport_id}/{folder}
export function clientFolderPath(passportId, documentType) {
    const storageType = DOCUMENT_STORAGE_TYPES[documentType];
    if (!storageType) {
        throw new Error(`Document type ${documentType} has no client folder`);
    }
    return `clients/${assertSafeSegment(passportId, "passport ID")}/${storageType.folder}`;
}

// pending/{unique_id}/undefined/uncleared-docs, or, when no client can be
// named safely, pending/unidentified/{temporary_id}/undefined/uncleared-docs.
// Never the WhatsApp number (decision D2).
export function pendingFolderPath({ uniqueId, temporaryId }) {
    const owner = uniqueId
        ? assertSafeSegment(uniqueId, "unique ID")
        : `unidentified/${assertSafeSegment(temporaryId, "temporary ID")}`;
    return `pending/${owner}/undefined/uncleared-docs`;
}

export function joinStoragePath(folder, fileName) {
    return `${folder}/${fileName}`;
}

// passport.pdf, passport_v2.pdf, passport_v3.pdf, …
export function standardFileName(documentType, version, extension) {
    const storageType = DOCUMENT_STORAGE_TYPES[documentType];
    if (!storageType) {
        throw new Error(`Document type ${documentType} has no standard name`);
    }
    if (!Number.isInteger(version) || version < 1) {
        throw new Error("Version must be a whole number from 1");
    }
    return version === 1
        ? `${storageType.baseName}${extension}`
        : `${storageType.baseName}_v${version}${extension}`;
}

const pad = (value) => String(value).padStart(2, "0");

// document_YYYYMMDD_HHMMSS.ext (UTC), the proposal §16 pattern. Also the
// fallback for UNCLEAR photos, which arrive without a file name.
export function timestampFileName(date, extension, prefix = "document") {
    const stamp =
        `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
    return `${prefix}_${stamp}${extension}`;
}

// Make a sender's file name safe to use as one storage object name:
// no directories, no "..", no control or unusual characters, and the
// extension from the MIME type. Returns null when nothing usable is left.
export function sanitizeFileName(originalFileName, extension) {
    if (typeof originalFileName !== "string") return null;

    // Keep only the last path segment, whichever separator was used.
    const lastSegment = originalFileName.split(/[\\/]/).pop();

    const baseName = lastSegment
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")        // accents: "é" -> "e"
        .replace(/[\u0000-\u001f\u007f]/g, "")  // control characters
        .replace(/\.[A-Za-z0-9]{1,10}$/, "")    // sender's extension is never trusted
        .replace(/[^A-Za-z0-9._-]+/g, "_")      // spaces and anything unusual
        .replace(/\.{2,}/g, ".")                 // no ".." anywhere
        .replace(/_{2,}/g, "_")
        .replace(/^[._-]+|[._-]+$/g, "")         // no leading dots (hidden files) or trailing junk
        .slice(0, MAX_BASE_NAME_LENGTH)
        .replace(/[._-]+$/g, "");

    return /[A-Za-z0-9]/.test(baseName) ? `${baseName}${extension}` : null;
}

// scan.pdf -> scan_2.pdf -> scan_3.pdf. Attempt 1 returns the name unchanged.
export function withNumericSuffix(fileName, attempt) {
    if (attempt <= 1) return fileName;

    const dot = fileName.lastIndexOf(".");
    return dot > 0
        ? `${fileName.slice(0, dot)}_${attempt}${fileName.slice(dot)}`
        : `${fileName}_${attempt}`;
}
