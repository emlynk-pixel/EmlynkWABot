// Visa Submission Phase 2: the VISA SUBMISSION/ part of the private bucket. Paths and names of what the
// extraction writes (visaExtractionService.js), and the read-only file browser of the admin page:
// list a folder, stream one file, stream a folder as a ZIP. Nothing here can reach outside
// VISA SUBMISSION/: every request path is validated (parseBrowsePath) and then prefixed with the root,
// so clients/, pending/ and every other root stay out of reach. No signed URL is ever created.

import crypto from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { VISA_SUBMISSION_PLAN_FOLDER, VISA_SUBMISSION_ROOT, VISA_ZIP_MAX_BYTES, VISA_ZIP_MAX_FILES } from "../config/visaSubmission.js";
import { STORAGE_TIMEOUT_MS, settleWithin } from "../utils/storageTimeout.js";
import { safeErrorInfo } from "../utils/safeLog.js";
import { CandidateError } from "./candidateService.js";

// Supabase's list() answers at most 100 entries a call.
const LIST_PAGE_SIZE = 100;
// A folder listing shows at most this many entries (truncated: true beyond).
export const BROWSE_MAX_ENTRIES = 1000;
const MAX_PATH_LENGTH = 512;
const MAX_PATH_DEPTH = 6;
// The ZIP walks at most this many folders (the extraction writes two levels: date / Plan B).
const ZIP_MAX_FOLDERS = 100;

// One path segment: what the extraction itself writes (dates, "Plan B", passport numbers, sanitized
// Client names). ASCII only: Supabase object keys accept ASCII word characters, space and a few
// punctuation marks, nothing else.
const SEGMENT = /^[A-Za-z0-9_.()&,'+ -]+$/;

const CONTENT_TYPES = new Map([
    [".pdf", "application/pdf"],
    [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
]);

// ---------------------------------------------------------------- names written by the extraction

// VISA SUBMISSION/{YYYY-MM-DD}/Plan B
export const extractionFolder = (date) => `${VISA_SUBMISSION_ROOT}/${date}/${VISA_SUBMISSION_PLAN_FOLDER}`;
export const extractionPdfPath = (folder, passportId) => `${folder}/${passportId}.pdf`;
export const candidateDetailsFileName = (clientFileName) => `Candidate_Details_${clientFileName}.xlsx`;
export const extraDetailsFileName = (clientFileName) => `Extra_Details_${clientFileName}.xlsx`;

// A Client's name as part of a file name, still readable ("Acme Ltd (RO)"): accents dropped, path
// separators and every character outside SEGMENT become a space, spaces collapsed, no leading dots.
export function clientFileNameOf(name) {
    const cleaned = String(name ?? "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^A-Za-z0-9_.()&,'+ -]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[.\s]+|[.\s]+$/g, "")
        .slice(0, 80)
        .trim();
    return /[A-Za-z0-9]/.test(cleaned) ? cleaned : "Client";
}

// ---------------------------------------------------------------- request paths

const invalidPath = () => new CandidateError(400, "INVALID_PATH", "Invalid path");

// `raw`: the path below VISA SUBMISSION/ ("" or undefined = the root), as given in the query string
// (Express has already decoded it once). Refused: anything but one string, a leading "/", a backslash,
// any "%" (an encoded or double-encoded traversal), control characters, empty, "." or ".." segments,
// and characters outside SEGMENT. { relative, key, segments }.
export function parseBrowsePath(raw) {
    if (raw === undefined || raw === "") return { relative: "", key: VISA_SUBMISSION_ROOT, segments: [] };
    if (typeof raw !== "string" || raw.length > MAX_PATH_LENGTH) throw invalidPath();
    if (/[\\%\u0000-\u001f\u007f]/.test(raw) || raw.startsWith("/")) throw invalidPath();
    const segments = raw.split("/");
    if (segments.length > MAX_PATH_DEPTH) throw invalidPath();
    for (const segment of segments) {
        if (!SEGMENT.test(segment) || segment.startsWith(".") || segment !== segment.trim()) throw invalidPath();
    }
    return { relative: raw, key: `${VISA_SUBMISSION_ROOT}/${raw}`, segments };
}

// ---------------------------------------------------------------- storage helpers

const storageUnavailable = () => new CandidateError(502, "STORAGE_UNAVAILABLE", "Storage could not be reached. Try again.");

// Every entry of a folder, page by page; Supabase marks a folder with id null. At most `max` entries
// (truncated: true when there were more). Hidden entries (.emptyFolderPlaceholder) and names the
// browser could not open are left out.
export async function listFolder(bucket, key, { max = BROWSE_MAX_ENTRIES, search, timeoutMs = STORAGE_TIMEOUT_MS } = {}) {
    const entries = [];
    for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
        const options = { limit: LIST_PAGE_SIZE, offset, sortBy: { column: "name", order: "asc" }, ...(search ? { search } : {}) };
        const { data, error } = await settleWithin(bucket.list(key, options), timeoutMs, "list");
        if (error) return { error };
        const page = Array.isArray(data) ? data : [];
        for (const item of page) {
            if (typeof item?.name !== "string" || !SEGMENT.test(item.name) || item.name.startsWith(".")) continue;
            const isFolder = item.id === null || item.id === undefined;
            const size = isFolder ? null : Number(item.metadata?.size ?? item.metadata?.contentLength ?? 0);
            entries.push({
                name: item.name,
                type: isFolder ? "folder" : "file",
                size,
                updatedAt: isFolder ? null : (item.updated_at ?? item.created_at ?? null),
            });
        }
        if (entries.length > max) return { entries: entries.slice(0, max), truncated: true };
        if (page.length < LIST_PAGE_SIZE) return { entries, truncated: false };
    }
}

// The one file `name` in folder `key`, or null (none, or a folder of that name).
async function findFile(bucket, folderKey, name, timeoutMs) {
    const listed = await listFolder(bucket, folderKey, { search: name, timeoutMs });
    if (listed.error) throw storageUnavailable();
    return listed.entries.find((entry) => entry.type === "file" && entry.name === name) ?? null;
}

// Supabase's download() reads the whole body into a Blob unless asked for the stream.
export async function openDownload(bucket, key, timeoutMs = STORAGE_TIMEOUT_MS) {
    const download = bucket.download(key);
    const { data, error } = await settleWithin(typeof download?.asStream === "function" ? download.asStream() : download, timeoutMs, "download");
    if (error || !data) return { error: error ?? new Error("empty download") };
    if (Buffer.isBuffer(data)) return { buffer: data };
    if (data instanceof Readable) return { stream: data };
    if (typeof data.getReader === "function") return { stream: Readable.fromWeb(data) };
    return { buffer: Buffer.from(await data.arrayBuffer()) };
}

// The whole object as a Buffer (the Excel files, which are small).
export async function downloadBuffer(bucket, key, timeoutMs = STORAGE_TIMEOUT_MS) {
    const opened = await openDownload(bucket, key, timeoutMs);
    if (opened.error) return { error: opened.error };
    if (opened.buffer) return { buffer: opened.buffer };
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    return { buffer: Buffer.concat(chunks) };
}

// Does folder `key` hold the file `name`? { exists } or { error }.
export async function fileExists(bucket, folderKey, name, timeoutMs = STORAGE_TIMEOUT_MS) {
    const listed = await listFolder(bucket, folderKey, { search: name, timeoutMs });
    if (listed.error) return { error: listed.error };
    return { exists: listed.entries.some((entry) => entry.type === "file" && entry.name === name) };
}

// Server-side copy of `from` onto `to`, replacing what `to` held. Supabase's copy refuses an existing
// destination, so the destination is removed first (only `to`; `from` is never moved or deleted).
export async function copyReplacing(bucket, from, to, timeoutMs = STORAGE_TIMEOUT_MS) {
    const removed = await settleWithin(bucket.remove([to]), timeoutMs, "remove");
    if (removed?.error) return { error: removed.error };
    const copied = await settleWithin(bucket.copy(from, to), timeoutMs, "copy");
    if (copied?.error) return { error: copied.error };
    return { ok: true };
}

// ---------------------------------------------------------------- the browser

const contentTypeOf = (name) => CONTENT_TYPES.get(name.slice(name.lastIndexOf(".")).toLowerCase()) ?? "application/octet-stream";

// attachment; an ASCII fallback name and the exact name (RFC 5987) for browsers that read it.
export function attachmentDisposition(name) {
    const ascii = String(name).replace(/[^A-Za-z0-9._ ()-]/g, "_").slice(0, 150) || "download";
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// GET …/visa-submission/storage: { path, entries: [{ name, type, size, updatedAt }], truncated }.
// A folder that does not exist (or is empty) below the root is 404 FOLDER_NOT_FOUND.
export async function browseFolder({ bucket, path }) {
    const { relative, key } = parseBrowsePath(path);
    const listed = await listFolder(bucket, key);
    if (listed.error) throw storageUnavailable();
    if (relative && listed.entries.length === 0) throw new CandidateError(404, "FOLDER_NOT_FOUND", "Folder not found");
    // Folders first, then files, each by name.
    const entries = [...listed.entries].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
    return { root: VISA_SUBMISSION_ROOT, path: relative, entries, truncated: listed.truncated };
}

// One file below the root (never a folder): { fileName, mimeType, size, stream | buffer, relative }.
export async function openStoredFile({ bucket, path, timeoutMs = STORAGE_TIMEOUT_MS }) {
    const { relative, segments } = parseBrowsePath(path);
    if (!relative) throw invalidPath();
    const name = segments.at(-1);
    const folderKey = [VISA_SUBMISSION_ROOT, ...segments.slice(0, -1)].join("/");
    const entry = await findFile(bucket, folderKey, name, timeoutMs);
    if (!entry) throw new CandidateError(404, "FILE_NOT_FOUND", "File not found");
    const opened = await openDownload(bucket, `${folderKey}/${name}`, timeoutMs);
    if (opened.error) throw storageUnavailable();
    const size = opened.buffer ? opened.buffer.length : entry.size;
    return { relative, fileName: name, mimeType: contentTypeOf(name), size: size || null, ...opened };
}

// The files a ZIP of folder `path` would hold, checked against the limits BEFORE anything is
// streamed: 413 ZIP_TOO_LARGE above VISA_ZIP_MAX_FILES files or VISA_ZIP_MAX_BYTES bytes.
// { relative, zipName, files: [{ key, name, size, updatedAt }], totalBytes }.
export async function planFolderZip({ bucket, path, maxFiles = VISA_ZIP_MAX_FILES, maxBytes = VISA_ZIP_MAX_BYTES, timeoutMs = STORAGE_TIMEOUT_MS }) {
    const { relative, key, segments } = parseBrowsePath(path);
    if (!relative) throw new CandidateError(400, "INVALID_PATH", "Choose a folder inside VISA SUBMISSION");
    const top = segments.at(-1);
    const files = [];
    let totalBytes = 0;
    let folders = 0;
    const tooLarge = () => new CandidateError(413, "ZIP_TOO_LARGE",
        `This folder is too large to download as one ZIP (limit ${maxFiles} files and ${Math.round(maxBytes / (1024 * 1024))} MB). Download a smaller folder or single files.`);
    const queue = [{ key, name: top }];
    while (queue.length) {
        const folder = queue.shift();
        folders += 1;
        if (folders > ZIP_MAX_FOLDERS) throw tooLarge();
        const listed = await listFolder(bucket, folder.key, { max: maxFiles + 1, timeoutMs });
        if (listed.error) throw storageUnavailable();
        for (const entry of listed.entries) {
            const child = { key: `${folder.key}/${entry.name}`, name: `${folder.name}/${entry.name}` };
            if (entry.type === "folder") {
                queue.push(child);
                continue;
            }
            files.push({ ...child, size: entry.size ?? 0, updatedAt: entry.updatedAt });
            totalBytes += entry.size ?? 0;
            if (files.length > maxFiles || totalBytes > maxBytes) throw tooLarge();
        }
        if (listed.truncated) throw tooLarge();
    }
    if (files.length === 0) throw new CandidateError(404, "FOLDER_NOT_FOUND", "Folder not found or empty");
    return { relative, zipName: `${segments.join(" - ")}.zip`, files, totalBytes };
}

// Streams the planned files into `out` as one ZIP, one file at a time (each storage download is
// streamed straight into the archive, never held whole: a Vercel response is not buffered).
// Entries are stored, not compressed: PDFs and xlsx files are compressed already, and the time goes
// to the 60 s limit. Throws when a file can't be read; the caller can only cut the response then.
export async function streamFolderZip({ bucket, plan, out, timeoutMs = STORAGE_TIMEOUT_MS }) {
    const { default: archiver } = await import("archiver");
    const archive = archiver("zip", { store: true });
    const written = pipeline(archive, out);
    // A failed write is reported by `written`; the loop below must not wait forever for it.
    written.catch(() => {});
    try {
        for (const file of plan.files) {
            const opened = await openDownload(bucket, file.key, timeoutMs);
            if (opened.error) throw new Error("A file of the ZIP could not be read from storage");
            const entry = once(archive, "entry");
            archive.append(opened.stream ?? opened.buffer, { name: file.name, ...(file.updatedAt ? { date: new Date(file.updatedAt) } : {}) });
            await entry;
        }
        await archive.finalize();
        await written;
    } catch (error) {
        archive.abort();
        console.warn("Visa submission ZIP: stream ended early", safeErrorInfo(error));
        throw error;
    }
}

// ---------------------------------------------------------------- audit

export const VISA_FILE_DOWNLOAD_AUDIT_ACTION = "VISA_SUBMISSION_FILE_DOWNLOAD";
export const VISA_ZIP_DOWNLOAD_AUDIT_ACTION = "VISA_SUBMISSION_ZIP_DOWNLOAD";

// One entry per file or ZIP download, written before the body is sent: the path below the root and
// sizes only (never a storage URL or anything of the session).
export async function recordStorageDownload({ db, actor, action, details }) {
    await db.auditLog.create({
        data: {
            auditId: crypto.randomUUID(),
            adminId: actor.adminId,
            action,
            previousStatus: "NONE",
            newStatus: "DOWNLOADED",
            newValue: JSON.stringify({ root: VISA_SUBMISSION_ROOT, ...details }),
        },
    });
}
