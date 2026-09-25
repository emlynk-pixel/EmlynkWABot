import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveAdmin } from "../src/middleware/requireActiveAdmin.js";
import {
    DEFAULT_REQUIRED_DOCUMENT_TYPES,
    loadRequiredDocumentTypes,
    parseRequiredDocumentTypes,
} from "../src/config/requiredDocuments.js";
import { findEnvProblems } from "../src/config/env.js";
import {
    REQUIRED_DOCUMENT_TYPES,
    clientSearchWhere,
    listClients,
    loadClientCompleteness,
    parseClientListQuery,
    parseMissingDocumentsQuery,
    requiredDocumentStatus,
    summarizeCompleteness,
} from "../src/services/adminClientService.js";
import { getClientDetails, getOverview } from "../src/services/adminDashboardService.js";
import { createFakeReviewDb } from "./helpers/fakeReviewDb.js";

Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-placeholder",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    META_APP_SECRET: "test-app-secret-placeholder",
    JWT_SECRET: "test-jwt-secret-placeholder-0123456789",
});
const { createApp } = await import("../src/createApp.js");

// Synthetic clients and documents only.
const ADMINS = [
    { adminId: "admin-active", name: "Active Admin", email: "a@example.invalid", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
    { adminId: "admin-inactive", name: "Inactive Admin", email: "i@example.invalid", passwordHash: "x", role: "ADMIN", status: "INACTIVE" },
];
const USERS = [
    { passportId: "N0000001", uniqueId: "0001", firstName: "KAMAL NIMAL", otherName: "PERERA", whatsappNumber: "94770000001" }, // complete
    { passportId: "N0000002", uniqueId: "0002", firstName: "SAMAN", otherName: "SILVA", whatsappNumber: "0770000002" },       // medical missing
    { passportId: "N0000003", uniqueId: "0003", firstName: "NIMALI", otherName: null, whatsappNumber: null },                // nothing at all
    { passportId: "N0000004", uniqueId: "0004", firstName: "RUWAN", otherName: "FERNANDO", whatsappNumber: "94770000004" },  // all received, one under review
];
let n = 0;
const doc = (passportId, documentType, verificationStatus = "VERIFIED") => ({
    documentId: `d-${++n}`, passportId, documentType, verificationStatus, processingStatus: "STORED",
    receivedDate: new Date("2026-09-20T03:00:00Z"), storedFilename: `${documentType.toLowerCase()}.pdf`, policeSubmittedDate: null,
});
const DOCUMENTS = [
    doc("N0000001", "PASSPORT"), doc("N0000001", "POLICE_REPORT"), doc("N0000001", "MEDICAL"),
    doc("N0000002", "PASSPORT"), doc("N0000002", "POLICE_REPORT"), doc("N0000002", "POLICE_SLIP"),
    doc("N0000004", "PASSPORT"), doc("N0000004", "POLICE_REPORT", "REVIEW_REQUIRED"),
];
const pending = (temporaryId, passportId, documentType) => ({
    temporaryId, passportId, uniqueId: null, whatsappNumber: "94770000009", documentType, temporaryStoragePath: `temporary/${temporaryId}`,
    processingStatus: "MANUAL_REVIEW", createdDate: new Date("2026-09-24T01:00:00Z"), pendingStoragePath: `pending/x/${temporaryId}.pdf`,
});
const TEMPORARY = [
    pending("t-1", "N0000004", "MEDICAL"),   // N0000004's medical waits for review
    pending("t-2", null, "MEDICAL"),         // unidentified: counts for nobody
    { ...pending("t-3", "N0000003", "PASSPORT"), pendingStoragePath: null, processingStatus: "FAILED" }, // FAILED, no pending copy
];

const fixture = () => createFakeReviewDb({ admins: ADMINS, users: USERS, documents: DOCUMENTS, temporaryData: TEMPORARY });

describe("REQUIRED_DOCUMENT_TYPES configuration", () => {
    test("default: passport, police report, medical", () => {
        assert.deepEqual(parseRequiredDocumentTypes(undefined).types, ["PASSPORT", "POLICE_REPORT", "MEDICAL"]);
        assert.deepEqual(parseRequiredDocumentTypes("  ").types, DEFAULT_REQUIRED_DOCUMENT_TYPES);
        assert.deepEqual(REQUIRED_DOCUMENT_TYPES, ["PASSPORT", "POLICE_REPORT", "MEDICAL"]);
    });

    test("a configured set is accepted (case and spaces don't matter)", () => {
        assert.deepEqual(parseRequiredDocumentTypes("passport, police_report , police_slip").types, ["PASSPORT", "POLICE_REPORT", "POLICE_SLIP"]);
        assert.deepEqual(parseRequiredDocumentTypes("PASSPORT").types, ["PASSPORT"]);
    });

    test("invalid values are refused, never used silently", () => {
        for (const value of ["PASSPORT,VISA", "PASSPORT,UNKNOWN", "PASSPORT,MEDICAL,MEDICAL", "MEDICAL,POLICE_REPORT", "PASSPORT,,MEDICAL", ","]) {
            const result = parseRequiredDocumentTypes(value);
            assert.ok(result.error, value);
            assert.equal(result.types, undefined, value);
            assert.throws(() => loadRequiredDocumentTypes({ REQUIRED_DOCUMENT_TYPES: value }), value);
        }
        // The configured text is not echoed back (only the allowed names).
        assert.ok(!parseRequiredDocumentTypes("PASSPORT,s3cr3t").error.includes("s3cr3t"));
    });

    test("the startup check reports an invalid value", () => {
        const valid = {
            DATABASE_URL: "postgresql://x", SUPABASE_URL: "https://x.example", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_BUCKET: "x",
            JWT_SECRET: "x".repeat(40), META_APP_SECRET: "x", WHATSAPP_VERIFY_TOKEN: "x", WHATSAPP_ACCESS_TOKEN: "x", WHATSAPP_API_VERSION: "v21.0",
        };
        assert.deepEqual(findEnvProblems(valid), []);
        assert.deepEqual(findEnvProblems({ ...valid, REQUIRED_DOCUMENT_TYPES: "PASSPORT,MEDICAL" }), []);
        assert.equal(findEnvProblems({ ...valid, REQUIRED_DOCUMENT_TYPES: "PASSPORT,VISA" }).length, 1);
    });

    test("the requirement rules follow the configured set", () => {
        const documents = [{ documentType: "PASSPORT", verificationStatus: "VERIFIED" }, { documentType: "POLICE_SLIP", verificationStatus: "VERIFIED" }];
        const result = requiredDocumentStatus({ documents, pendingItems: [], requiredTypes: ["PASSPORT", "POLICE_SLIP"] });
        assert.deepEqual(result.map((r) => [r.documentType, r.status]), [["PASSPORT", "VERIFIED"], ["POLICE_SLIP", "VERIFIED"]]);
    });
});

describe("client completeness", () => {
    test("each client's required documents, in three queries", async () => {
        const db = fixture();
        const before = db.calls.length;
        const rows = await loadClientCompleteness({ db: db.client });
        assert.equal(db.calls.length - before, 3);
        const byId = Object.fromEntries(rows.map((row) => [row.client.passportId, row]));
        assert.equal(byId.N0000001.completion, "COMPLETE");
        assert.deepEqual(byId.N0000001.missingDocumentTypes, []);
        assert.equal(byId.N0000002.completion, "INCOMPLETE");
        assert.deepEqual(byId.N0000002.missingDocumentTypes, ["MEDICAL"]); // the police slip is not required
        assert.deepEqual(byId.N0000003.missingDocumentTypes, ["PASSPORT", "POLICE_REPORT", "MEDICAL"]); // a FAILED submission is not "received"
        assert.equal(byId.N0000004.completion, "INCOMPLETE");
        assert.deepEqual(byId.N0000004.missingDocumentTypes, []);
        assert.deepEqual(byId.N0000004.requirements.map((r) => r.status), ["VERIFIED", "REVIEW_REQUIRED", "PENDING_REVIEW"]);
    });

    test("summary: complete, incomplete, missing per type", async () => {
        const rows = await loadClientCompleteness({ db: fixture().client });
        assert.deepEqual(summarizeCompleteness(rows), {
            total: 4, complete: 1, incomplete: 3, withMissing: 2, missingDocuments: 4,
            missingByType: { PASSPORT: 1, POLICE_REPORT: 1, MEDICAL: 2 },
        });
    });

    test("same status as the client page (shared rule)", async () => {
        const db = fixture();
        const rows = await loadClientCompleteness({ db: db.client });
        for (const row of rows) {
            const details = await getClientDetails({ db: db.client, passportId: row.client.passportId });
            assert.deepEqual(details.requiredDocuments.map((r) => r.status), row.requirements.map((r) => r.status), row.client.passportId);
            assert.deepEqual(details.missingDocumentTypes, row.missingDocumentTypes);
            assert.equal(details.complete, row.completion === "COMPLETE");
        }
    });

    test("the Overview shows the same counts", async () => {
        const overview = await getOverview({ db: fixture().client, now: new Date("2026-09-25T06:00:00Z") });
        assert.deepEqual(overview.clients, { total: 4, complete: 1, incomplete: 3, withMissing: 2, missingDocuments: 4, missingByType: { PASSPORT: 1, POLICE_REPORT: 1, MEDICAL: 2 } });
        assert.deepEqual(overview.requiredDocumentTypes, ["PASSPORT", "POLICE_REPORT", "MEDICAL"]);
    });
});

describe("client search", () => {
    const search = async (text) => (await listClients({ db: fixture().client, params: { page: 1, pageSize: 25, search: text } })).items.map((i) => i.client.passportId);

    test("by passport ID, unique ID, name (any order) and WhatsApp number", async () => {
        assert.deepEqual(await search("n0000002"), ["N0000002"]);
        assert.deepEqual(await search("0003"), ["N0000003"]);
        assert.deepEqual(await search("perera kamal"), ["N0000001"]);
        assert.deepEqual(await search("fernando"), ["N0000004"]);
        assert.deepEqual(await search("94770000001"), ["N0000001"]);
    });

    test("a number matches in both Sri Lankan formats", async () => {
        assert.deepEqual(await search("0770000001"), ["N0000001"]); // stored as 947…
        assert.deepEqual(await search("94770000002"), ["N0000002"]); // stored as 07…
        assert.deepEqual(await search("+94 77 000 0004"), []); // spaces inside a number are separate words
        assert.deepEqual(await search("+94770000004"), ["N0000004"]);
    });

    test("where clause: every word must match one field", () => {
        const where = clientSearchWhere("kamal 0771");
        assert.equal(where.AND.length, 2);
        assert.ok(where.AND[1].OR.some((c) => c.whatsappNumber?.contains === "94771"));
        assert.deepEqual(clientSearchWhere("   "), {});
    });
});

const tokenFor = (adminId) => jwt.sign({ adminId }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
let server;
let base;
let db;
before(async () => {
    const app = createApp({ adminApiRouter: (req, res, next) => createAdminRouter({ db: db.client, requireAdmin: createRequireActiveAdmin({ db: db.client }) })(req, res, next) });
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(() => server.close());
async function get(path, token = tokenFor("admin-active")) {
    const response = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: response.status, body: await response.json().catch(() => null) };
}

describe("GET /api/admin/clients", () => {
    test("every client with completeness, summary and pagination", async () => {
        db = fixture();
        const { status, body } = await get("/clients");
        assert.equal(status, 200);
        assert.deepEqual(body.items.map((i) => i.client.uniqueId), ["0001", "0002", "0003", "0004"]);
        assert.deepEqual(body.items[1], {
            client: { passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", whatsappNumber: "0770000002" },
            completion: "INCOMPLETE",
            requirements: [
                { documentType: "PASSPORT", status: "VERIFIED", storedCount: 1, pendingCount: 0 },
                { documentType: "POLICE_REPORT", status: "VERIFIED", storedCount: 1, pendingCount: 0 },
                { documentType: "MEDICAL", status: "MISSING", storedCount: 0, pendingCount: 0 },
            ],
            missingDocumentTypes: ["MEDICAL"],
        });
        assert.equal(body.summary.complete, 1);
        assert.equal(body.summary.incomplete, 3);
        assert.deepEqual(body.requiredDocumentTypes, ["PASSPORT", "POLICE_REPORT", "MEDICAL"]);
        assert.deepEqual(body.pagination, { page: 1, pageSize: 25, total: 4, totalPages: 1 });
    });

    test("filters: complete / incomplete / missing type; summary before the filter", async () => {
        db = fixture();
        assert.deepEqual((await get("/clients?completion=COMPLETE")).body.items.map((i) => i.client.passportId), ["N0000001"]);
        const incomplete = await get("/clients?completion=INCOMPLETE");
        assert.deepEqual(incomplete.body.items.map((i) => i.client.passportId), ["N0000002", "N0000003", "N0000004"]);
        assert.equal(incomplete.body.summary.total, 4);
        assert.deepEqual((await get("/clients?missingType=MEDICAL")).body.items.map((i) => i.client.passportId), ["N0000002", "N0000003"]);
        const searched = await get("/clients?search=saman&completion=COMPLETE");
        assert.deepEqual(searched.body.items, []);
        assert.equal(searched.body.summary.total, 1);
        assert.deepEqual(searched.body.filters, { search: "saman", completion: "COMPLETE", missingType: null });
    });

    test("pagination", async () => {
        db = fixture();
        const { body } = await get("/clients?page=2&pageSize=3");
        assert.deepEqual(body.items.map((i) => i.client.passportId), ["N0000004"]);
        assert.deepEqual(body.pagination, { page: 2, pageSize: 3, total: 4, totalPages: 2 });
    });

    test("invalid parameters -> 400, nothing queried", async () => {
        db = fixture();
        for (const query of ["completion=DONE", "missingType=UNKNOWN", "missingType=POLICE_SLIP", "page=0", "pageSize=101", `search=${"x".repeat(101)}`, "page=1&page=2"]) {
            const before = db.calls.length;
            const { status, body } = await get(`/clients?${query}`);
            assert.equal(status, 400, query);
            assert.equal(body.message, "Invalid query parameters");
            assert.equal(db.calls.length, before, query);
        }
        assert.deepEqual(parseClientListQuery({ foo: "bar" }).params, { page: 1, pageSize: 25, completion: undefined, missingType: undefined });
    });

    test("needs an ACTIVE admin", async () => {
        db = fixture();
        assert.equal((await get("/clients", null)).status, 401);
        assert.equal((await get("/clients", tokenFor("admin-inactive"))).status, 401);
        assert.equal((await get("/documents/missing", null)).status, 401);
    });
});

describe("GET /api/admin/documents/missing", () => {
    test("incomplete clients, most missing first, with counts", async () => {
        db = fixture();
        const { status, body } = await get("/documents/missing");
        assert.equal(status, 200);
        assert.deepEqual(body.items.map((i) => [i.client.passportId, i.missingDocumentTypes]), [
            ["N0000003", ["PASSPORT", "POLICE_REPORT", "MEDICAL"]],
            ["N0000002", ["MEDICAL"]],
            ["N0000004", []], // all received, but not all verified yet
        ]);
        assert.deepEqual(body.summary, { total: 4, complete: 1, incomplete: 3, withMissing: 2, missingDocuments: 4, missingByType: { PASSPORT: 1, POLICE_REPORT: 1, MEDICAL: 2 } });
    });

    test("filter by missing document type, search, pagination", async () => {
        db = fixture();
        assert.deepEqual((await get("/documents/missing?documentType=MEDICAL")).body.items.map((i) => i.client.passportId), ["N0000003", "N0000002"]);
        assert.deepEqual((await get("/documents/missing?documentType=PASSPORT")).body.items.map((i) => i.client.passportId), ["N0000003"]);
        assert.deepEqual((await get("/documents/missing?search=silva")).body.items.map((i) => i.client.passportId), ["N0000002"]);
        const paged = await get("/documents/missing?pageSize=2&page=2");
        assert.deepEqual(paged.body.items.map((i) => i.client.passportId), ["N0000004"]);
        assert.equal(paged.body.pagination.totalPages, 2);
        assert.equal((await get("/documents/missing?documentType=VISA")).status, 400);
        assert.ok(parseMissingDocumentsQuery({ documentType: "MEDICAL" }).params);
    });

    test("is not mistaken for a documents list parameter", async () => {
        db = fixture();
        const { body } = await get("/documents/missing");
        assert.ok(Array.isArray(body.items) && "summary" in body && !("byVerificationStatus" in body.summary));
    });
});
