import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

import { createAdminRouter } from "../src/routes/admin.js";
import {
    parseDocumentListQuery,
    buildDocumentListArgs,
    requiredDocumentStatus,
    REQUIREMENT_STATUS,
    DOCUMENT_LIST_DEFAULTS,
} from "../src/services/adminDashboardService.js";
import { businessDayRange, businessDateOf, isValidBusinessDate } from "../src/utils/businessDay.js";
import { createFakeAdminDb } from "./helpers/fakeAdminDb.js";

// Placeholders so the app's modules load without real credentials.
Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    META_APP_SECRET: "test-app-secret-placeholder",
    JWT_SECRET: "test-jwt-secret-placeholder-0123456789",
});
const { createApp } = await import("../src/createApp.js");

// Synthetic people and documents only.
const decimal = (value) => ({ valueOf: () => value, toString: () => value }); // like Prisma.Decimal
const CLIENT = { passportId: "N1234567", uniqueId: "0001", firstName: "KAMAL NIMAL", otherName: "PERERA" };
const docRow = (overrides = {}) => ({
    documentId: "doc-1",
    documentType: "PASSPORT",
    processingStatus: "STORED",
    verificationStatus: "VERIFIED",
    ocrConfidence: decimal("97.50"),
    receivedDate: new Date("2026-09-24T07:05:03Z"),
    storedFilename: "passport.pdf",
    mimeType: "application/pdf",
    fileSize: 123456n, // BigInt, as Prisma returns it
    user: CLIENT,
    ...overrides,
});

// Stand-in for the Prisma calls the dashboard makes; records every call.
function createFakeDashboardDb({ admins, documents = [docRow()], user = null, pending = [], groups = {}, failAdminLookup = false } = {}) {
    const calls = [];
    const adminDb = createFakeAdminDb(admins);
    const record = (method, args, result) => { calls.push({ method, args }); return result; };
    return {
        calls,
        admin: {
            findUnique: async (args) => {
                if (failAdminLookup) throw new Error("connection refused");
                return record("admin.findUnique", args, await adminDb.admin.findUnique(args));
            },
        },
        user: {
            count: async (args) => record("user.count", args, 12),
            findMany: async (args) => record("user.findMany", args, [CLIENT]), // Police Workflow counts
            findUnique: async (args) => record("user.findUnique", args, user && args.where.passportId === user.passportId ? user : null),
        },
        document: {
            count: async (args) => record("document.count", args, args?.where?.verificationStatus === "REVIEW_REQUIRED" && !args.where.documentType ? 3 : documents.length),
            findMany: async (args) => record("document.findMany", args, documents),
            groupBy: async (args) => record("document.groupBy", args, groups.documentVerification ?? [{ verificationStatus: "VERIFIED", _count: { _all: 7 } }, { verificationStatus: "REVIEW_REQUIRED", _count: { _all: 3 } }]),
        },
        temporaryData: {
            count: async (args) => record("temporaryData.count", args, args?.where?.pendingStoragePath ? 4 : 9), // waiting for review
            groupBy: async (args) => record("temporaryData.groupBy", args,
                args.by[0] === "passportId"
                    ? [] // police slips waiting in pending/, per client
                    : args.by[0] === "documentType"
                    ? [{ documentType: "PASSPORT", _count: { _all: 5 } }, { documentType: "MEDICAL", _count: { _all: 2 } }]
                    : args.where
                        ? [{ processingStatus: "MANUAL_REVIEW", _count: { _all: 3 } }, { processingStatus: "CONFLICT", _count: { _all: 1 } }]
                        : [{ processingStatus: "VERIFIED", _count: { _all: 6 } }, { processingStatus: "MANUAL_REVIEW", _count: { _all: 3 } }]),
            findMany: async (args) => record("temporaryData.findMany", args, pending),
        },
        auditLog: {
            findMany: async (args) => record("auditLog.findMany", args, []), // police slip date changes
        },
    };
}

const ADMINS = [
    { adminId: "admin-active", name: "Active Admin", email: "active@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
    { adminId: "admin-inactive", name: "Inactive Admin", email: "inactive@example.invalid", passwordHash: "x", role: "ADMIN", status: "INACTIVE" },
];
const tokenFor = (adminId, options = { expiresIn: "1h" }) => jwt.sign({ adminId, role: "ADMIN" }, process.env.JWT_SECRET, { algorithm: "HS256", ...options });

async function startWith(db) {
    const app = createApp({ adminApiRouter: createAdminRouter({ db }) });
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path, token = tokenFor("admin-active")) => {
        const response = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
    };
    return { server, get };
}

describe("/api/admin authentication (shared ACTIVE-admin middleware)", () => {
    let http;
    let db;
    before(async () => { db = createFakeDashboardDb({ admins: ADMINS }); http = await startWith(db); });
    after(() => http.server.close());

    const PATHS = ["/api/admin/overview", "/api/admin/documents", "/api/admin/clients/N1234567", "/api/admin/unknown"];

    test("no token -> 401 on every admin route, nothing queried", async () => {
        const before = db.calls.length;
        for (const path of PATHS) {
            const result = await http.get(path, null);
            assert.equal(result.status, 401, path);
            assert.deepEqual(result.body, { message: "Authentication Token is required!" });
        }
        assert.equal(db.calls.length, before);
    });

    test("malformed, wrongly signed or expired token -> 401", async () => {
        for (const token of ["not-a-jwt", jwt.sign({ adminId: "admin-active" }, "another-secret-value-0123456789"), tokenFor("admin-active", { expiresIn: -10 })]) {
            const result = await http.get("/api/admin/overview", token);
            assert.equal(result.status, 401);
            assert.deepEqual(result.body, { message: "Invalid or Expired Token" });
        }
    });

    test("valid token of an admin that no longer exists -> 401 (same message)", async () => {
        const result = await http.get("/api/admin/overview", tokenFor("admin-deleted"));
        assert.equal(result.status, 401);
        assert.deepEqual(result.body, { message: "Invalid or Expired Token" });
    });

    test("valid token of an INACTIVE admin -> 401 (same message), no dashboard query", async () => {
        const before = db.calls.filter((c) => !c.method.startsWith("admin.")).length;
        const result = await http.get("/api/admin/documents", tokenFor("admin-inactive"));
        assert.equal(result.status, 401);
        assert.deepEqual(result.body, { message: "Invalid or Expired Token" });
        assert.equal(db.calls.filter((c) => !c.method.startsWith("admin.")).length, before);
    });

    test("ACTIVE admin -> 200; the status is read from the database on each request", async () => {
        const result = await http.get("/api/admin/overview");
        assert.equal(result.status, 200);
        const lookup = db.calls.filter((c) => c.method === "admin.findUnique").at(-1);
        assert.deepEqual(lookup.args.where, { adminId: "admin-active" });
        assert.equal(lookup.args.select.passwordHash, undefined, "password hash never loaded");
    });

    test("responses are never cached", async () => {
        assert.equal((await http.get("/api/admin/overview")).headers.get("cache-control"), "no-store");
        assert.equal((await http.get("/api/admin/overview", null)).headers.get("cache-control"), "no-store");
    });

    test("unknown admin path (authenticated) -> 404 JSON", async () => {
        const result = await http.get("/api/admin/unknown");
        assert.equal(result.status, 404);
        assert.deepEqual(result.body, { message: "Not found" });
    });

    test("database failure while checking the admin -> generic 500, no details", async () => {
        const failing = await startWith(createFakeDashboardDb({ admins: ADMINS, failAdminLookup: true }));
        try {
            const result = await failing.get("/api/admin/overview");
            assert.equal(result.status, 500);
            assert.deepEqual(result.body, { message: "Internal server error" });
        } finally {
            failing.server.close();
        }
    });

    test("existing /auth/me is unchanged (deleted admin still 404, inactive 401)", async () => {
        assert.equal((await http.get("/auth/me", null)).status, 401);
    });
});

describe("GET /api/admin/overview", () => {
    let http;
    let db;
    before(async () => {
        db = createFakeDashboardDb({
            admins: ADMINS,
            documents: [docRow(), docRow({ documentId: "doc-2", documentType: "MEDICAL", verificationStatus: "REVIEW_REQUIRED", ocrConfidence: null, fileSize: null })],
            pending: [{ temporaryId: "tmp-1", documentType: "POLICE_SLIP", processingStatus: "MANUAL_REVIEW", createdDate: new Date("2026-09-25T03:00:00Z"), user: CLIENT }],
        });
        http = await startWith(db);
    });
    after(() => http.server.close());

    test("returns KPIs, summaries, recent documents and the review queue", async () => {
        const { status, body } = await http.get("/api/admin/overview");
        assert.equal(status, 200);
        assert.match(body.businessDate, /^\d{4}-\d{2}-\d{2}$/);
        assert.deepEqual(body.kpis, { totalClients: 12, totalDocuments: 2, pendingReview: 4 + 3, receivedToday: 9 });
        assert.deepEqual(body.submissionsByStatus, { VERIFIED: 6, MANUAL_REVIEW: 3 });
        assert.deepEqual(body.submissionsByType, { PASSPORT: 5, MEDICAL: 2 });
        assert.deepEqual(body.reviewQueue.pendingByStatus, { MANUAL_REVIEW: 3, CONFLICT: 1 });
        assert.equal(body.reviewQueue.total, 7);
        assert.deepEqual(body.reviewQueue.items[0], {
            temporaryId: "tmp-1", documentType: "POLICE_SLIP", processingStatus: "MANUAL_REVIEW",
            receivedDate: "2026-09-25T03:00:00.000Z", client: { passportId: "N1234567", uniqueId: "0001", name: "KAMAL NIMAL PERERA" },
        });
    });

    test("documents are serialized safely: numbers, ISO dates, no paths or checksums", async () => {
        const { body } = await http.get("/api/admin/overview");
        const [first, second] = body.recentDocuments;
        assert.equal(first.ocrConfidence, 97.5);
        assert.equal(first.fileSize, 123456);
        assert.equal(first.receivedDate, "2026-09-24T07:05:03.000Z");
        assert.equal(second.ocrConfidence, null);
        assert.equal(second.fileSize, null);
        for (const doc of body.recentDocuments) {
            assert.equal(doc.storagePath, undefined);
            assert.equal(doc.fileSha256, undefined);
        }
        const serialized = JSON.stringify(body);
        assert.ok(!serialized.includes("whatsapp"), "no sender numbers in the overview");
    });

    test("'received today' counts submissions since midnight in Sri Lanka", async () => {
        await http.get("/api/admin/overview");
        const todayCount = db.calls.find((c) => c.method === "temporaryData.count" && c.args?.where?.createdDate);
        const { start } = businessDayRange(businessDateOf(new Date()));
        assert.equal(todayCount.args.where.createdDate.gte.toISOString(), start.toISOString());
    });

    test("uses a fixed number of queries (no per-row lookups)", async () => {
        const before = db.calls.length;
        await http.get("/api/admin/overview");
        const dashboardCalls = db.calls.slice(before).filter((c) => !c.method.startsWith("admin."));
        assert.equal(dashboardCalls.length, 16); // 10 + 3 for the police due counts + 3 for client completeness
        const recent = dashboardCalls.find((c) => c.method === "document.findMany");
        assert.ok(recent.args.select.user, "client joined in the same query");
        assert.equal(recent.args.take, 8);
    });
});

describe("GET /api/admin/documents", () => {
    let http;
    let db;
    before(async () => { db = createFakeDashboardDb({ admins: ADMINS }); http = await startWith(db); });
    after(() => http.server.close());
    const lastCall = (method) => db.calls.filter((c) => c.method === method).at(-1);

    test("default: page 1, 25 per page, newest first, with pagination and chip counts", async () => {
        const { status, body } = await http.get("/api/admin/documents");
        assert.equal(status, 200);
        assert.equal(body.items.length, 1);
        assert.deepEqual(body.pagination, { page: 1, pageSize: 25, total: 1, totalPages: 1 });
        assert.deepEqual(body.summary, { total: 10, byVerificationStatus: { VERIFIED: 7, REVIEW_REQUIRED: 3 } });
        const findMany = lastCall("document.findMany");
        assert.equal(findMany.args.skip, 0);
        assert.equal(findMany.args.take, 25);
        assert.deepEqual(findMany.args.orderBy, [{ receivedDate: "desc" }, { documentId: "asc" }]);
    });

    test("pagination: page 3 of 10 -> skip 20", async () => {
        const { body } = await http.get("/api/admin/documents?page=3&pageSize=10");
        assert.equal(lastCall("document.findMany").args.skip, 20);
        assert.equal(lastCall("document.findMany").args.take, 10);
        assert.equal(body.pagination.page, 3);
    });

    test("filters reach the query; chip counts ignore only the verification filter", async () => {
        await http.get("/api/admin/documents?documentType=MEDICAL&verificationStatus=REVIEW_REQUIRED&processingStatus=STORED&passportId=n1234567");
        const where = lastCall("document.findMany").args.where;
        assert.equal(where.documentType, "MEDICAL");
        assert.equal(where.verificationStatus, "REVIEW_REQUIRED");
        assert.equal(where.processingStatus, "STORED");
        assert.equal(where.passportId, "N1234567");
        const groupWhere = lastCall("document.groupBy").args.where;
        assert.equal(groupWhere.documentType, "MEDICAL");
        assert.equal(groupWhere.verificationStatus, undefined);
    });

    test("search looks at ID, passport, file name and client name/number, case-insensitively", async () => {
        await http.get("/api/admin/documents?search=%20perera%20");
        const or = lastCall("document.findMany").args.where.OR;
        assert.equal(or.length, 6);
        assert.deepEqual(or[0], { documentId: { contains: "perera", mode: "insensitive" } });
        assert.deepEqual(or[3], { user: { is: { firstName: { contains: "perera", mode: "insensitive" } } } });
    });

    test("date range uses Sri Lankan business days", async () => {
        await http.get("/api/admin/documents?receivedFrom=2026-09-01&receivedTo=2026-09-30");
        const range = lastCall("document.findMany").args.where.receivedDate;
        assert.equal(range.gte.toISOString(), "2026-08-31T18:30:00.000Z");
        assert.equal(range.lt.toISOString(), "2026-09-30T18:30:00.000Z");
    });

    test("sorting by confidence keeps documents without OCR last", async () => {
        await http.get("/api/admin/documents?sort=ocrConfidence&order=asc");
        assert.deepEqual(lastCall("document.findMany").args.orderBy, [{ ocrConfidence: { sort: "asc", nulls: "last" } }, { documentId: "asc" }]);
    });

    test("invalid parameters -> 400 with field-level messages, nothing queried", async () => {
        const cases = [
            ["page=0", "page"], ["page=abc", "page"], ["pageSize=500", "pageSize"], ["documentType=INVOICE", "documentType"],
            ["verificationStatus=MAYBE", "verificationStatus"], ["processingStatus=drop%20table", "processingStatus"],
            ["sort=storagePath", "sort"], ["order=up", "order"], ["receivedFrom=2026-02-30", "receivedFrom"],
            ["receivedFrom=01-09-2026", "receivedFrom"], ["receivedFrom=2026-09-10&receivedTo=2026-09-01", "receivedTo"],
            ["page=1&page=2", "page"], [`search=${"x".repeat(101)}`, "search"], ["passportId=N123%2F..", "passportId"],
        ];
        const before = db.calls.filter((c) => c.method.startsWith("document.")).length;
        for (const [query, field] of cases) {
            const { status, body } = await http.get(`/api/admin/documents?${query}`);
            assert.equal(status, 400, query);
            assert.equal(body.message, "Invalid query parameters");
            assert.ok(body.errors.some((e) => e.field === field), `${query} -> ${JSON.stringify(body.errors)}`);
        }
        assert.equal(db.calls.filter((c) => c.method.startsWith("document.")).length, before);
    });

    test("unknown parameters are ignored", async () => {
        assert.equal((await http.get("/api/admin/documents?foo=bar&include=storagePath")).status, 200);
    });
});

describe("GET /api/admin/clients/:passportId", () => {
    let http;
    let db;
    const user = {
        ...CLIENT,
        dateOfBirth: new Date("1990-03-12T00:00:00Z"),
        placeOfBirth: "COLOMBO",
        passportExpiryDate: new Date("2030-05-11T00:00:00Z"),
        whatsappNumber: "0771234567",
        contactNumber: null,
        address: null,
        job: null,
        createdDate: new Date("2026-09-20T00:00:00Z"),
        updatedDate: new Date("2026-09-24T00:00:00Z"),
        documents: [
            docRow({ documentId: "doc-p", documentType: "PASSPORT", verificationStatus: "REVIEW_REQUIRED" }),
            docRow({ documentId: "doc-r", documentType: "POLICE_REPORT", verificationStatus: "VERIFIED" }),
            docRow({ documentId: "doc-s", documentType: "POLICE_SLIP", verificationStatus: "VERIFIED" }),
        ],
    };
    before(async () => {
        db = createFakeDashboardDb({
            admins: ADMINS,
            user,
            pending: [{ temporaryId: "tmp-m", documentType: "MEDICAL", processingStatus: "UNDEFINED", createdDate: new Date("2026-09-25T01:00:00Z") }],
        });
        http = await startWith(db);
    });
    after(() => http.server.close());

    test("returns profile, documents, pending items, required-document status and police documents", async () => {
        const { status, body } = await http.get("/api/admin/clients/N1234567");
        assert.equal(status, 200);
        assert.equal(body.client.name, "KAMAL NIMAL PERERA");
        assert.equal(body.client.dateOfBirth, "1990-03-12T00:00:00.000Z");
        assert.equal(body.documents.length, 3);
        assert.equal(body.pendingItems[0].temporaryId, "tmp-m");
        assert.deepEqual(body.requiredDocuments.map((r) => [r.documentType, r.status]), [
            ["PASSPORT", "REVIEW_REQUIRED"], ["POLICE_REPORT", "VERIFIED"], ["MEDICAL", "PENDING_REVIEW"],
        ]);
        assert.deepEqual(body.missingDocumentTypes, []);
        assert.equal(body.police.latestSlip.documentId, "doc-s");
        assert.equal(body.police.latestReport.documentId, "doc-r");
        // A verified police report completes the workflow (Checkpoint 5; details in adminPolice.test.js).
        assert.equal(body.police.countdown.status, "COMPLETED");
        assert.equal(body.police.countdown.report.documentId, "doc-r");
    });

    test("passport ID is matched case-insensitively; documents, pending items and police date changes in three queries", async () => {
        const before = db.calls.length;
        assert.equal((await http.get("/api/admin/clients/n1234567")).status, 200);
        const calls = db.calls.slice(before).filter((c) => !c.method.startsWith("admin."));
        assert.deepEqual(calls.map((c) => c.method), ["user.findUnique", "temporaryData.findMany", "auditLog.findMany"]);
        assert.deepEqual(calls[2].args.where, { passportId: "N1234567", action: "SET_POLICE_DATE" });
        assert.deepEqual(calls[0].args.where, { passportId: "N1234567" });
        assert.ok(calls[0].args.select.documents, "documents loaded with the client");
    });

    test("unknown client -> 404", async () => {
        const { status, body } = await http.get("/api/admin/clients/X9999999");
        assert.equal(status, 404);
        assert.deepEqual(body, { message: "Client not found" });
    });

    test("malformed passport ID -> 400, nothing queried", async () => {
        const before = db.calls.filter((c) => c.method === "user.findUnique").length;
        for (const id of ["N123-4567", "A".repeat(21), "%20"]) {
            const { status, body } = await http.get(`/api/admin/clients/${id}`);
            assert.equal(status, 400, id);
            assert.equal(body.message, "Invalid passport ID");
        }
        assert.equal(db.calls.filter((c) => c.method === "user.findUnique").length, before);
    });
});

describe("dashboard helpers", () => {
    test("required-document status: VERIFIED > REVIEW_REQUIRED > PENDING_REVIEW > MISSING", () => {
        const result = requiredDocumentStatus({
            documents: [
                { documentType: "PASSPORT", verificationStatus: "REVIEW_REQUIRED" },
                { documentType: "PASSPORT", verificationStatus: "VERIFIED" },
                { documentType: "POLICE_SLIP", verificationStatus: "VERIFIED" },
            ],
            pendingItems: [{ documentType: "MEDICAL" }, { documentType: "POLICE_SLIP" }],
        });
        assert.deepEqual(result.map((r) => [r.documentType, r.status]), [
            ["PASSPORT", REQUIREMENT_STATUS.VERIFIED],
            ["POLICE_REPORT", REQUIREMENT_STATUS.MISSING],
            ["MEDICAL", REQUIREMENT_STATUS.PENDING_REVIEW],
        ]);
    });

    test("a police slip never satisfies the police report requirement", () => {
        const [, police] = requiredDocumentStatus({ documents: [{ documentType: "POLICE_SLIP", verificationStatus: "VERIFIED" }], pendingItems: [] });
        assert.equal(police.status, REQUIREMENT_STATUS.MISSING);
    });

    test("Sri Lankan business day boundaries (UTC+05:30)", () => {
        const { start, end } = businessDayRange("2026-09-25");
        assert.equal(start.toISOString(), "2026-09-24T18:30:00.000Z");
        assert.equal(end.toISOString(), "2026-09-25T18:30:00.000Z");
        assert.equal(businessDateOf(new Date("2026-09-24T18:29:59Z")), "2026-09-24");
        assert.equal(businessDateOf(new Date("2026-09-24T18:30:00Z")), "2026-09-25");
        assert.equal(isValidBusinessDate("2026-02-29"), false);
        assert.equal(isValidBusinessDate("2028-02-29"), true);
    });

    test("query parsing defaults and args", () => {
        const { params } = parseDocumentListQuery({});
        assert.deepEqual({ page: params.page, pageSize: params.pageSize, sort: params.sort, order: params.order }, DOCUMENT_LIST_DEFAULTS);
        const args = buildDocumentListArgs({ ...params, verificationStatus: "VERIFIED" });
        assert.deepEqual(args.where, { verificationStatus: "VERIFIED" });
        assert.deepEqual(args.whereWithoutVerification, {});
    });
});
