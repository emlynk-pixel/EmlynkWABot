import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jwt from "jsonwebtoken";

import { createAdminRouter } from "../src/routes/admin.js";
import {
    parseReviewQueueQuery,
    buildReviewWhere,
    parseReviewId,
    toReviewId,
    REVIEW_PENDING_WHERE,
    REVIEW_QUEUE_WINDOW,
} from "../src/services/adminReviewService.js";
import { deriveReviewReason, REVIEW_REASON, REVIEW_REASON_CATEGORY } from "../src/services/reviewReason.js";
import { processDocument } from "../src/services/documentProcessingService.js";
import { createFakeAdminDb } from "./helpers/fakeAdminDb.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";
import { loadDocumentText } from "./helpers/fixtures.js";

Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    META_APP_SECRET: "test-app-secret-placeholder",
    JWT_SECRET: "test-jwt-secret-placeholder-0123456789",
});
const { createApp } = await import("../src/createApp.js");

// Synthetic data only.
const TEMP_A = "11111111-1111-4111-8111-111111111111";
const TEMP_B = "22222222-2222-4222-8222-222222222222";
const DOC_R = "33333333-3333-4333-8333-333333333333";
const CLIENT = { passportId: "N1234567", uniqueId: "0001", firstName: "KAMAL NIMAL", otherName: "PERERA" };
const SUMMARY = {
    stage: "COMPLETED", error: null, processingStatus: "MANUAL_REVIEW", documentType: "PASSPORT",
    confidence: { extraction: 71, classification: 100, document: 71, band: "SLIGHTLY_UNCLEAR", measuredBand: "SLIGHTLY_UNCLEAR", flags: [] },
    identity: { status: "PASSPORT_MATCH_ONLY", reviewRequired: true, provisional: false, notes: ["WHATSAPP_NOT_ON_RECORD"] },
};
const pendingRow = (overrides = {}) => ({
    temporaryId: TEMP_A, documentType: "PASSPORT", processingStatus: "MANUAL_REVIEW", reviewReason: "IDENTITY_NOT_CONFIRMED",
    processingSummary: SUMMARY, whatsappNumber: "94770000000", createdDate: new Date("2026-09-24T01:00:00Z"),
    pendingStoragePath: "pending/0001/undefined/uncleared-docs/document_20260924_063000.pdf", temporaryStoragePath: "temporary/aaaa.pdf",
    user: CLIENT, ...overrides,
});
const documentRow = (overrides = {}) => ({
    documentId: DOC_R, documentType: "MEDICAL", processingStatus: "STORED", verificationStatus: "REVIEW_REQUIRED",
    ocrConfidence: { valueOf: () => "50.00" }, receivedDate: new Date("2026-09-24T03:00:00Z"), storedFilename: "scan.pdf",
    storagePath: "clients/N1234567/medical/scan.pdf", mimeType: "application/pdf", fileSize: 2048n, user: CLIENT,
    temporaryData: { temporaryId: TEMP_B, reviewReason: "LOW_CONFIDENCE", processingSummary: { ...SUMMARY, confidence: { ...SUMMARY.confidence, band: "UNCLEAR", document: 50 } }, whatsappNumber: "94771234567", createdDate: new Date("2026-09-24T02:59:00Z") },
    ...overrides,
});

// Fake Prisma for the review routes; records every call.
function fakeReviewDb({ pending = [pendingRow()], documents = [documentRow()] } = {}) {
    const calls = [];
    const admins = createFakeAdminDb([
        { adminId: "admin-active", name: "A", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
        { adminId: "admin-inactive", name: "I", email: "i@example.invalid", passwordHash: "x", role: "ADMIN", status: "INACTIVE" },
    ]);
    const idIn = (where, key) => where?.AND?.find((c) => c[key])?.[key];
    const record = (method, args, value) => { calls.push({ method, args }); return value; };
    return {
        calls,
        admin: admins.admin,
        temporaryData: {
            count: async (args) => record("temporaryData.count", args, pending.length),
            findMany: async (args) => record("temporaryData.findMany", args, pending.slice(0, args.take)),
            groupBy: async (args) => record("temporaryData.groupBy", args, [{ reviewReason: "IDENTITY_NOT_CONFIRMED", _count: { _all: pending.length } }]),
            findFirst: async (args) => record("temporaryData.findFirst", args, pending.find((p) => p.temporaryId === idIn(args.where, "temporaryId")) ?? null),
        },
        document: {
            count: async (args) => record("document.count", args, documents.length),
            findMany: async (args) => record("document.findMany", args, args.take ? documents.slice(0, args.take) : documents),
            findFirst: async (args) => record("document.findFirst", args, documents.find((d) => d.documentId === idIn(args.where, "documentId")) ?? null),
        },
        // Review history (Checkpoint 4; covered in adminReviewActions.test.js).
        auditLog: { findMany: async (args) => record("auditLog.findMany", args, []) },
    };
}

const tokenFor = (adminId) => jwt.sign({ adminId }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });

async function startWith(db, bucket = createFakeBucket([])) {
    const app = createApp({ adminApiRouter: createAdminRouter({ db, bucket }) });
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path, token = tokenFor("admin-active")) => {
        const response = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        const type = response.headers.get("content-type") ?? "";
        const body = type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer());
        return { status: response.status, headers: response.headers, body };
    };
    return { server, get };
}

describe("migration 20260925150000_phase10_review_data", () => {
    const sql = fs.readFileSync(new URL("../prisma/migrations/20260925150000_phase10_review_data/migration.sql", import.meta.url), "utf8");
    const schema = fs.readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

    test("is additive: nullable columns, an index and a SET NULL foreign key only", () => {
        const statements = sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
        assert.equal(statements.length, 4);
        for (const statement of statements) {
            assert.match(statement, /^(ALTER TABLE "(documents|temporary_data)" ADD |CREATE INDEX )/, statement);
        }
        // ON DELETE SET NULL / ON UPDATE CASCADE are clauses of the foreign key.
        assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /\bDROP\b|\bRENAME\b|NOT NULL|\bTRUNCATE\b|^\s*(UPDATE|DELETE)\b/im);
        assert.match(sql, /ALTER TABLE "documents" ADD COLUMN "temporary_id" TEXT;/);
        assert.match(sql, /ADD COLUMN "processing_summary" JSONB,\s*ADD COLUMN "review_reason" TEXT;/);
        assert.match(sql, /ON DELETE SET NULL/);
    });

    test("schema matches: optional fields, relation with onDelete SetNull", () => {
        assert.match(schema, /processingSummary\s+Json\?\s+@map\("processing_summary"\)/);
        assert.match(schema, /reviewReason\s+String\?\s+@map\("review_reason"\)/);
        assert.match(schema, /temporaryId\s+String\?\s+@map\("temporary_id"\)/);
        assert.match(schema, /onDelete: SetNull/);
    });
});

describe("review reasons (existing pipeline decisions, named)", () => {
    const state = (overrides = {}) => ({
        processingStatus: "MANUAL_REVIEW",
        resolvedType: { documentType: "PASSPORT" },
        confidence: { band: "VERIFIED", flags: [] },
        identity: { status: "VERIFIED_MATCH", reviewRequired: false },
        reconciliation: { conflicts: [] },
        policeDate: null,
        checksum: { outcome: "NEW" },
        ...overrides,
    });

    test("one code per existing rule, most serious first", () => {
        assert.equal(deriveReviewReason(state({ processingStatus: "FAILED", checksum: { outcome: "CROSS_CLIENT_CONFLICT" } })), REVIEW_REASON.PROCESSING_FAILED);
        assert.equal(deriveReviewReason(state({ checksum: { outcome: "CROSS_CLIENT_CONFLICT" }, identity: { status: "IDENTITY_CONFLICT" } })), REVIEW_REASON.CROSS_CLIENT_DUPLICATE);
        assert.equal(deriveReviewReason(state({ identity: { status: "IDENTITY_CONFLICT", reviewRequired: true } })), REVIEW_REASON.IDENTITY_CONFLICT);
        assert.equal(deriveReviewReason(state({ reconciliation: { conflicts: [{ field: "dateOfBirth" }] } })), REVIEW_REASON.RECORD_CONFLICT);
        assert.equal(deriveReviewReason(state({ resolvedType: { documentType: "UNKNOWN" }, confidence: { band: "UNDEFINED", flags: [] } })), REVIEW_REASON.DOCUMENT_TYPE_UNCLEAR);
        assert.equal(deriveReviewReason(state({ confidence: { band: "UNDEFINED", flags: ["POLICE_TYPE_UNCLEAR"] } })), REVIEW_REASON.DOCUMENT_TYPE_UNCLEAR);
        assert.equal(deriveReviewReason(state({ confidence: { band: "UNCLEAR", flags: ["WRONG_DOCUMENT_SUSPECTED"] } })), REVIEW_REASON.WRONG_DOCUMENT_SUSPECTED);
        assert.equal(deriveReviewReason(state({ identity: { status: "PASSPORT_MATCH_ONLY", reviewRequired: true } })), REVIEW_REASON.IDENTITY_NOT_CONFIRMED);
        assert.equal(deriveReviewReason(state({ resolvedType: { documentType: "POLICE_SLIP" }, policeDate: { status: "AMBIGUOUS" } })), REVIEW_REASON.POLICE_DATE_UNRESOLVED);
        assert.equal(deriveReviewReason(state({ confidence: { band: "UNCLEAR", flags: ["PASSPORT_ACCEPTED_BY_MRZ_AND_IDENTITY"] } })), REVIEW_REASON.LOW_CONFIDENCE);
        assert.equal(deriveReviewReason(state({ confidence: { band: "UNDEFINED", flags: [] } })), REVIEW_REASON.LOW_CONFIDENCE);
    });

    test("nothing to review -> null (clear documents and same-client duplicates)", () => {
        assert.equal(deriveReviewReason(state({ processingStatus: "VERIFIED" })), null);
        assert.equal(deriveReviewReason(state({ processingStatus: "DUPLICATE", confidence: { band: "UNDEFINED", flags: [] } })), null);
    });

    test("every code has a summary category", () => {
        for (const code of Object.values(REVIEW_REASON)) assert.ok(REVIEW_REASON_CATEGORY[code], code);
    });
});

describe("processing writes the review data (existing behaviour unchanged)", () => {
    const TEMP_PATH = "temporary/tmp-r.pdf";
    const users = [
        { passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: "KAMAL NIMAL", dateOfBirth: new Date("1990-03-12T00:00:00Z"), passportExpiryDate: new Date("2030-05-11T00:00:00Z") },
        { passportId: "N7654321", uniqueId: "0002", whatsappNumber: "0772223333", firstName: "NIMAL" },
    ];
    async function run({ text, confidence, sender = "94771234567" }) {
        const db = createFakePrisma(users.map((u) => ({ ...u })));
        const { summary } = await processDocument({
            temporaryId: "tmp-r", whatsappNumber: sender, fileName: "scan.pdf", mimeType: "application/pdf",
            fileBuffer: Buffer.from("%PDF-1.4 synthetic"), temporaryStoragePath: TEMP_PATH,
            deps: { db, bucket: createFakeBucket([TEMP_PATH]), now: new Date("2026-09-24T07:05:03Z"), extractText: async () => (confidence === undefined ? { success: true, method: "PDF_TEXT", text } : { success: true, method: "OCR", text, confidence }) },
        });
        return { summary, update: db.calls.filter((c) => c.method === "temporaryData.update").at(-1).data, db };
    }

    test("identity conflict -> CONFLICT, reason IDENTITY_CONFLICT, placement unchanged", async () => {
        const { summary, update } = await run({ text: loadDocumentText("passport-mrz"), sender: "94772223333" });
        assert.equal(summary.processingStatus, "CONFLICT");
        assert.equal(summary.storage.placement, "PENDING");
        assert.equal(update.reviewReason, "IDENTITY_CONFLICT");
        assert.equal(update.processingSummary.identity.status, "IDENTITY_CONFLICT");
    });

    test("low-confidence stored document -> REVIEW_REQUIRED row linked to its submission", async () => {
        const { summary, update, db } = await run({ text: loadDocumentText("medical-gamca"), confidence: 50 });
        assert.equal(summary.storage.verificationStatus, "REVIEW_REQUIRED");
        assert.equal(update.reviewReason, "LOW_CONFIDENCE");
        assert.equal(db.documentRows[0].temporaryId, "tmp-r");
    });

    test("the stored summary equals the logged summary apart from the final stage", async () => {
        const { summary, update } = await run({ text: loadDocumentText("passport-mrz") });
        const { stage, recordUpdated, ...rest } = update.processingSummary;
        const { stage: loggedStage, recordUpdated: loggedUpdated, ...loggedRest } = summary;
        assert.equal(stage, "COMPLETED");
        assert.equal(recordUpdated, true);
        assert.deepEqual(rest, loggedRest);
        assert.ok(!JSON.stringify(update.processingSummary).match(/N1234567|KAMAL|0771234567|temporary\//));
    });
});

describe("GET /api/admin/review (queue)", () => {
    let http;
    let db;
    before(async () => { db = fakeReviewDb(); http = await startWith(db); });
    after(() => http.server.close());
    // The list queries (the summary's findMany has no `take`).
    const lastCall = (method) => db.calls.filter((c) => c.method === method && (!method.endsWith("findMany") || c.args?.take)).at(-1);

    test("requires a token and an ACTIVE admin", async () => {
        assert.equal((await http.get("/api/admin/review", null)).status, 401);
        const inactive = await http.get("/api/admin/review", tokenFor("admin-inactive"));
        assert.equal(inactive.status, 401);
        assert.deepEqual(inactive.body, { message: "Invalid or Expired Token" });
        assert.equal((await http.get("/api/admin/review/pending-" + TEMP_A, tokenFor("admin-inactive"))).status, 401);
        assert.equal((await http.get("/api/admin/review/pending-" + TEMP_A + "/file", null)).status, 401);
    });

    test("merges waiting files and REVIEW_REQUIRED documents, oldest first", async () => {
        const { status, body, headers } = await http.get("/api/admin/review");
        assert.equal(status, 200);
        assert.equal(headers.get("cache-control"), "no-store");
        assert.deepEqual(body.items.map((i) => i.reviewId), [`pending-${TEMP_A}`, `document-${DOC_R}`]);
        assert.deepEqual(body.items[0], {
            reviewId: `pending-${TEMP_A}`, kind: "PENDING", documentType: "PASSPORT", processingStatus: "MANUAL_REVIEW",
            verificationStatus: null, reviewReason: "IDENTITY_NOT_CONFIRMED", reviewCategory: "IDENTITY", confidence: 71,
            receivedDate: "2026-09-24T01:00:00.000Z", client: { passportId: "N1234567", uniqueId: "0001", name: "KAMAL NIMAL PERERA" },
        });
        assert.equal(body.items[1].confidence, 50);
        assert.equal(body.items[1].reviewReason, "LOW_CONFIDENCE");
        assert.deepEqual(body.pagination, { page: 1, pageSize: 25, total: 2, totalPages: 1 });
        assert.deepEqual(body.summary.byCategory, { IDENTITY: 1, QUALITY: 1, CONFLICT: 0, OTHER: 0 });
        const serialized = JSON.stringify(body);
        assert.ok(!serialized.includes("pending/") && !serialized.includes("clients/") && !serialized.includes("94770000000"), "no paths or sender numbers in the queue");
    });

    test("the waiting set is 'file in pending/' only; FAILED alone does not count", async () => {
        assert.deepEqual(REVIEW_PENDING_WHERE, { pendingStoragePath: { not: null } });
        assert.ok(!JSON.stringify(REVIEW_PENDING_WHERE).includes("FAILED"));
        await http.get("/api/admin/review");
        assert.deepEqual(lastCall("temporaryData.findMany").args.where.AND[0], REVIEW_PENDING_WHERE);
        assert.deepEqual(lastCall("document.count").args.where.AND[0], { verificationStatus: "REVIEW_REQUIRED" });
    });

    test("filters and paging reach both queries", async () => {
        await http.get("/api/admin/review?documentType=MEDICAL&passportId=n1234567&reviewReason=RECORD_CONFLICT&order=desc&page=2&pageSize=10");
        const pendingArgs = lastCall("temporaryData.findMany").args;
        assert.deepEqual(pendingArgs.where.AND.slice(1), [{ documentType: "MEDICAL" }, { passportId: "N1234567" }, { reviewReason: "RECORD_CONFLICT" }]);
        assert.equal(pendingArgs.take, 20, "window = page x pageSize");
        assert.deepEqual(pendingArgs.orderBy, [{ createdDate: "desc" }, { temporaryId: "asc" }]);
        assert.deepEqual(lastCall("document.findMany").args.where.AND.at(-1), { temporaryData: { is: { reviewReason: "RECORD_CONFLICT" } } });
    });

    test("kind limits the sources queried", async () => {
        const before = db.calls.filter((c) => c.method === "document.count").length;
        const { body } = await http.get("/api/admin/review?kind=PENDING");
        assert.ok(body.items.every((i) => i.kind === "PENDING"));
        assert.equal(db.calls.filter((c) => c.method === "document.count").length, before);
    });

    test("invalid parameters -> 400 with field messages", async () => {
        for (const [query, field] of [["page=0", "page"], ["pageSize=101", "pageSize"], ["kind=ALLX", "kind"], ["documentType=INVOICE", "documentType"], ["reviewReason=URGENT", "reviewReason"], ["order=up", "order"], ["passportId=N1%2F2", "passportId"], ["page=1&page=2", "page"], ["page=100&pageSize=100", "page"]]) {
            const { status, body } = await http.get(`/api/admin/review?${query}`);
            assert.equal(status, 400, query);
            assert.ok(body.errors.some((e) => e.field === field), `${query}: ${JSON.stringify(body.errors)}`);
        }
    });

    test("paging is bounded by the queue window", () => {
        assert.equal(REVIEW_QUEUE_WINDOW, 1000);
        assert.ok(parseReviewQueueQuery({ page: "10", pageSize: "100" }).params);
        assert.ok(parseReviewQueueQuery({ page: "11", pageSize: "100" }).errors);
    });

    test("LOW_CONFIDENCE also matches review documents stored before the link existed", () => {
        const { document } = buildReviewWhere({ reviewReason: "LOW_CONFIDENCE" });
        assert.deepEqual(document.AND.at(-1), { OR: [{ temporaryData: { is: { reviewReason: "LOW_CONFIDENCE" } } }, { temporaryId: null }] });
    });
});

describe("GET /api/admin/review/:reviewId (detail) and /file", () => {
    let http;
    let bucket;
    before(async () => {
        bucket = { downloads: [], async download(path) { this.downloads.push(path); return { data: Buffer.from("%PDF-1.4 synthetic file"), error: null }; } };
        http = await startWith(fakeReviewDb(), bucket);
    });
    after(() => http.server.close());

    test("waiting file: reason, identity, sender, processing summary, preview link", async () => {
        const { status, body } = await http.get(`/api/admin/review/pending-${TEMP_A}`);
        assert.equal(status, 200);
        assert.equal(body.kind, "PENDING");
        assert.equal(body.reviewReason, "IDENTITY_NOT_CONFIRMED");
        assert.equal(body.client.passportId, "N1234567");
        assert.deepEqual(body.submission, { whatsappNumber: "94770000000", receivedDate: "2026-09-24T01:00:00.000Z" });
        assert.deepEqual(body.processing.identity.notes, ["WHATSAPP_NOT_ON_RECORD"]);
        assert.equal(body.document.confidence, 71);
        assert.deepEqual(body.file, {
            name: "document_20260924_063000.pdf", mimeType: "application/pdf", size: null, location: "PENDING",
            previewUrl: `/api/admin/review/pending-${TEMP_A}/file`,
        });
        assert.ok(!JSON.stringify(body).includes("pending/0001"), "no storage path");
    });

    test("stored document: its submission's summary and reason", async () => {
        const { body } = await http.get(`/api/admin/review/document-${DOC_R}`);
        assert.equal(body.kind, "DOCUMENT");
        assert.equal(body.document.verificationStatus, "REVIEW_REQUIRED");
        assert.equal(body.document.confidence, 50);
        assert.equal(body.processing.confidence.band, "UNCLEAR");
        assert.equal(body.file.size, 2048);
        assert.equal(body.file.location, "CLIENT");
        assert.ok(!JSON.stringify(body).includes("clients/N1234567"), "no storage path");
    });

    test("unknown item -> 404; malformed ID -> 400", async () => {
        assert.deepEqual((await http.get("/api/admin/review/pending-99999999-9999-4999-8999-999999999999")).body, { message: "Review item not found" });
        assert.equal((await http.get("/api/admin/review/document-99999999-9999-4999-8999-999999999999")).status, 404);
        for (const id of ["abc", "pending-", "other-" + TEMP_A, "pending-..%2F..%2Fx"]) {
            assert.equal((await http.get(`/api/admin/review/${id}`)).status, 400, id);
        }
    });

    test("file: streamed through the backend from the path in the database, sandboxed, not cached", async () => {
        const { status, headers, body } = await http.get(`/api/admin/review/pending-${TEMP_A}/file`);
        assert.equal(status, 200);
        assert.equal(headers.get("content-type"), "application/pdf");
        assert.equal(headers.get("cache-control"), "no-store");
        assert.match(headers.get("content-disposition"), /^inline; filename="document_20260924_063000\.pdf"$/);
        assert.match(headers.get("content-security-policy"), /sandbox/);
        assert.equal(body.toString(), "%PDF-1.4 synthetic file");
        assert.equal(bucket.downloads.at(-1), "pending/0001/undefined/uncleared-docs/document_20260924_063000.pdf");
    });

    test("file of an unknown item -> 404, storage never touched", async () => {
        const before = bucket.downloads.length;
        assert.equal((await http.get(`/api/admin/review/pending-99999999-9999-4999-8999-999999999999/file`)).status, 404);
        assert.equal(bucket.downloads.length, before);
    });

    test("storage error -> 502 without details", async () => {
        const failing = await startWith(fakeReviewDb(), { download: async () => ({ data: null, error: { message: "Object not found at pending/0001/..." } }) });
        try {
            const { status, body } = await failing.get(`/api/admin/review/pending-${TEMP_A}/file`);
            assert.equal(status, 502);
            assert.deepEqual(body, { message: "The file could not be loaded from storage" });
        } finally {
            failing.server.close();
        }
    });

    test("review IDs round-trip", () => {
        assert.deepEqual(parseReviewId(toReviewId("PENDING", TEMP_A)), { kind: "PENDING", id: TEMP_A });
        assert.deepEqual(parseReviewId(toReviewId("DOCUMENT", DOC_R)), { kind: "DOCUMENT", id: DOC_R });
        assert.equal(parseReviewId("pending-../../etc"), null);
    });
});

describe("Content Security Policy for the in-page preview", () => {
    test("blob: is allowed for images and frames only; scripts stay same-origin", async () => {
        const http = await startWith(fakeReviewDb());
        try {
            const csp = (await http.get("/health", null)).headers.get("content-security-policy");
            assert.match(csp, /img-src 'self' data: blob:/);
            assert.match(csp, /frame-src 'self' blob:/);
            assert.match(csp, /script-src 'self'(;|$)/);
            assert.match(csp, /object-src 'none'/);
            assert.doesNotMatch(csp, /script-src[^;]*blob:/);
        } finally {
            http.server.close();
        }
    });
});
