// Audit log export (POST /api/admin/audit-logs/export): validation, the
// list's filters, empty / over-cap answers, ADMIN only, keyset batches and
// the spreadsheet formula-injection guard. On a REAL PostgreSQL (PGlite,
// every migration applied) through the real Prisma client. The file writers
// are replaced by a recorder for the route tests; the real Excel / PDF files
// are checked only when exceljs / pdfkit are installed.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
    MAX_AUDIT_EXPORT_ROWS,
    NO_AUDIT_EXPORT_MATCHES_MESSAGE,
    auditLogExportItems,
    parseAuditLogExportBody,
    prepareAuditLogExport,
} from "../src/services/auditLogService.js";
import { exportRowOf, loadAuditLogExportWriter, spreadsheetSafe } from "../src/services/auditLogExportWriters.js";

const USERS = {
    ADMIN: { adminId: "user-admin", authUserId: "00000000-0000-4000-8000-000000000001", name: "Ada Admin", email: "ada@example.com", role: "ADMIN" },
    OWNER: { adminId: "user-owner", authUserId: "00000000-0000-4000-8000-000000000002", name: "Olive Owner", email: "olive@example.com", role: "OWNER" },
    ANALYST: { adminId: "user-analyst", authUserId: "00000000-0000-4000-8000-000000000003", name: "Ali Analyst", email: "ali@example.com", role: "ANALYST" },
    TEAM_LEAD: { adminId: "user-lead", authUserId: "00000000-0000-4000-8000-000000000004", name: "Tia Lead", email: "tia@example.com", role: "TEAM_LEAD" },
};
const profile = (role) => ({ ...USERS[role], status: "ACTIVE" });

const installed = (name) => {
    try {
        createRequire(import.meta.url).resolve(name);
        return true;
    } catch {
        return false;
    }
};

let database;
let prisma;
let pg;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const user of Object.values(USERS)) await prisma.user.create({ data: user });
});
after(async () => database?.close());

beforeEach(async () => {
    await pg.exec(`ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;`);
});

let sequence = 0;
async function entry({
    action = "UPDATE_CANDIDATE", adminId = USERS.ADMIN.adminId, passportId = null, createdDate = new Date("2026-11-10T06:00:00Z"),
    previousStatus = "SAVED", newStatus = "SAVED", reason = null, previousValue = null, newValue = null, documentType = null,
} = {}) {
    sequence += 1;
    const auditId = `audit-${String(sequence).padStart(6, "0")}`;
    await prisma.auditLog.create({ data: { auditId, adminId, action, passportId, previousStatus, newStatus, reason, previousValue, newValue, documentType, createdDate } });
    return auditId;
}

// A spread of entries over three business days, users, actions and passports.
async function seed() {
    await entry({ passportId: "N1023757", createdDate: new Date("2026-11-08T04:00:00Z"), previousValue: JSON.stringify({ surname: "Old" }), newValue: JSON.stringify({ surname: "New" }), reason: "Changed: surname" });
    await entry({ passportId: "n1023757", action: "APPROVE", previousStatus: "PENDING", newStatus: "APPROVED", createdDate: new Date("2026-11-09T04:00:00Z") });
    await entry({ passportId: "P7654321", adminId: USERS.ANALYST.adminId, action: "UPLOAD_DOCUMENT", documentType: "PASSPORT", createdDate: new Date("2026-11-09T05:00:00Z") });
    await entry({ action: "INVITE_USER", previousStatus: "NONE", newStatus: "INVITED", newValue: "someone@example.com", createdDate: new Date("2026-11-10T04:00:00Z") });
    await entry({ action: "LEGACY_THING", adminId: USERS.ANALYST.adminId, createdDate: new Date("2026-11-10T05:00:00Z"), reason: "older version" });
}

// The export's file writer, replaced: records what it was given and answers
// with the entries' IDs as JSON.
function recordingWriter(calls) {
    return async (format) => async ({ items, out, total }) => {
        const received = [];
        for await (const item of items) received.push(item);
        calls.push({ format, total, items: received });
        out.end(JSON.stringify(received.map((i) => i.auditId)));
    };
}

async function withServer({ role = "ADMIN", user, loadExportWriter } = {}, work) {
    const app = express();
    app.use(express.json());
    const requireAdmin = (req, res, next) => {
        const who = user === undefined ? profile(role) : user;
        if (who) req.user = who;
        next();
    };
    app.use("/api/admin", createAdminRouter({ db: prisma, requireAdmin, apiLimiter: noRateLimit, ...(loadExportWriter ? { loadExportWriter } : {}) }));
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/admin`;
    try {
        return await work(async (path, { method = "GET", body } = {}) => {
            const response = await fetch(`${base}${path}`, {
                method,
                headers: { "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const text = await response.text();
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { /* a file */ }
            return { status: response.status, headers: response.headers, body: json, text };
        });
    } finally {
        server.close();
    }
}

describe("export body validation", () => {
    test("format must be xlsx or pdf", () => {
        for (const format of [undefined, "", "csv", "XLSX", 1, null]) {
            const parsed = parseAuditLogExportBody({ format });
            assert.ok(parsed.errors?.some((e) => e.field === "format"), String(format));
            assert.equal(parsed.message, "Format must be xlsx or pdf.");
        }
        assert.deepEqual(parseAuditLogExportBody({ format: "xlsx" }), { params: {}, format: "xlsx" });
        assert.deepEqual(parseAuditLogExportBody({ format: "pdf" }), { params: {}, format: "pdf" });
    });

    test("not an object -> 400 errors", () => {
        for (const body of [null, undefined, [], "xlsx"]) assert.ok(parseAuditLogExportBody(body).errors, String(body));
    });

    test("the list's filters and their rules; empty filters are no filter; pagination is ignored", () => {
        const parsed = parseAuditLogExportBody({
            format: "pdf", adminId: "user-admin", passportId: "N1023757", candidate: "Anusha", action: "APPROVE",
            category: "REVIEW", startDate: "2026-11-01", endDate: "2026-11-30", search: "x", page: "3", pageSize: "100", candidateExtra: "ignored",
        });
        assert.deepEqual(parsed, {
            format: "pdf",
            params: { adminId: "user-admin", passportId: "N1023757", candidate: "Anusha", action: "APPROVE", category: "REVIEW", startDate: "2026-11-01", endDate: "2026-11-30", search: "x" },
        });
        assert.deepEqual(parseAuditLogExportBody({ format: "xlsx", passportId: "", search: null, action: "  " }), { params: {}, format: "xlsx" });
        assert.equal(parseAuditLogExportBody({ format: "xlsx", category: "NOPE" }).errors[0].field, "category");
        assert.equal(parseAuditLogExportBody({ format: "xlsx", startDate: "2026-02-30" }).message, "Start date must be a date as YYYY-MM-DD.");
        assert.equal(parseAuditLogExportBody({ format: "xlsx", adminId: ["a", "b"] }).message, "Performed by must be text.");
        assert.equal(parseAuditLogExportBody({ format: "xlsx", search: "x".repeat(101) }).errors[0].field, "search");
    });

    test("start date after end date: its own message", () => {
        const parsed = parseAuditLogExportBody({ format: "xlsx", startDate: "2026-11-20", endDate: "2026-11-01" });
        assert.equal(parsed.message, "The start date must be on or before the end date.");
    });

    test("an error never repeats the submitted value (a passport number)", () => {
        const parsed = parseAuditLogExportBody({ format: "doc", passportId: "N1023757<script>" });
        assert.ok(parsed.errors.some((e) => e.field === "passportId"));
        const text = JSON.stringify(parsed);
        assert.ok(!text.includes("N1023757"), text);
        assert.match(parsed.message, /^Format must be xlsx or pdf \(and 1 more problem\)\.$/);
    });
});

describe("POST /api/admin/audit-logs/export", () => {
    test("400 with a user-facing message, never the submitted passport number", async () => {
        await withServer({}, async (call) => {
            const bad = await call("/audit-logs/export", { method: "POST", body: { format: "xlsx", passportId: "N1023757 OR 1=1" } });
            assert.equal(bad.status, 400);
            assert.equal(bad.body.error, "INVALID_EXPORT_REQUEST");
            assert.equal(bad.body.message, "Passport number must be a passport ID.");
            assert.deepEqual(bad.body.errors, [{ field: "passportId", message: "must be a passport ID" }]);
            assert.ok(!bad.text.includes("N1023757"));

            const range = await call("/audit-logs/export", { method: "POST", body: { format: "pdf", startDate: "2026-11-20", endDate: "2026-11-01" } });
            assert.equal(range.status, 400);
            assert.equal(range.body.message, "The start date must be on or before the end date.");

            const format = await call("/audit-logs/export", { method: "POST", body: { format: "csv" } });
            assert.equal(format.status, 400);
            assert.equal(format.body.message, "Format must be xlsx or pdf.");

            const none = await call("/audit-logs/export", { method: "POST" });
            assert.equal(none.status, 400);
        });
    });

    test("no matching entry -> 404 with the agreed message, no file", async () => {
        const calls = [];
        await withServer({ loadExportWriter: recordingWriter(calls) }, async (call) => {
            const empty = await call("/audit-logs/export", { method: "POST", body: { format: "xlsx" } });
            assert.equal(empty.status, 404);
            assert.deepEqual(empty.body, { error: "NO_MATCHING_RECORDS", message: NO_AUDIT_EXPORT_MATCHES_MESSAGE });
            assert.equal(empty.body.message, "No audit log records match the selected filters");
            await seed();
            const filtered = await call("/audit-logs/export", { method: "POST", body: { format: "pdf", action: "DEACTIVATE_USER" } });
            assert.equal(filtered.status, 404);
            assert.equal(filtered.body.message, NO_AUDIT_EXPORT_MATCHES_MESSAGE);
        });
        assert.equal(calls.length, 0);
    });

    test(`more than ${MAX_AUDIT_EXPORT_ROWS} matching entries -> 413 "narrow your filters"`, async () => {
        await pg.exec(`
            INSERT INTO "audit_logs" ("audit_id", "admin_id", "action", "previous_status", "new_status", "created_date")
            SELECT 'bulk-' || lpad(n::text, 6, '0'), 'user-admin', 'UPDATE_CANDIDATE', 'A', 'B', TIMESTAMP '2026-11-01 00:00:00' + n * INTERVAL '1 second'
            FROM generate_series(1, ${MAX_AUDIT_EXPORT_ROWS + 1}) AS n;
        `);
        const calls = [];
        await withServer({ loadExportWriter: recordingWriter(calls) }, async (call) => {
            const big = await call("/audit-logs/export", { method: "POST", body: { format: "xlsx" } });
            assert.equal(big.status, 413);
            assert.equal(big.body.error, "EXPORT_TOO_LARGE");
            assert.match(big.body.message, /Narrow your filters/);
            assert.ok(big.body.message.length <= 200);
            assert.equal(big.body.limit, MAX_AUDIT_EXPORT_ROWS);
            // A narrower range is under the cap.
            const narrow = await call("/audit-logs/export", { method: "POST", body: { format: "xlsx", search: "bulk" } });
            assert.equal(narrow.status, 404, "search does not look at audit IDs");
        });
        assert.equal(calls.length, 0);
    });

    test("ADMIN and OWNER only: other roles 403, no session 401, nothing read", async () => {
        await seed();
        const calls = [];
        for (const role of ["ANALYST", "TEAM_LEAD"]) {
            await withServer({ role, loadExportWriter: recordingWriter(calls) }, async (call) => {
                assert.equal((await call("/audit-logs/export", { method: "POST", body: { format: "xlsx" } })).status, 403, role);
            });
        }
        await withServer({ user: null, loadExportWriter: recordingWriter(calls) }, async (call) => {
            assert.equal((await call("/audit-logs/export", { method: "POST", body: { format: "xlsx" } })).status, 401);
        });
        assert.equal(calls.length, 0);
        await withServer({ role: "OWNER", loadExportWriter: recordingWriter(calls) }, async (call) => {
            assert.equal((await call("/audit-logs/export", { method: "POST", body: { format: "pdf" } })).status, 200);
        });
    });

    test("a file download: content type, attachment name audit-log-<date>, no caching", async () => {
        await seed();
        await withServer({ loadExportWriter: recordingWriter([]) }, async (call) => {
            for (const [format, type] of [["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["pdf", "application/pdf"]]) {
                const response = await call("/audit-logs/export", { method: "POST", body: { format } });
                assert.equal(response.status, 200);
                assert.equal(response.headers.get("content-type"), type);
                assert.match(response.headers.get("content-disposition"), new RegExp(`^attachment; filename="audit-log-\\d{4}-\\d{2}-\\d{2}\\.${format}"$`));
                assert.equal(response.headers.get("cache-control"), "no-store");
            }
        });
    });

    test("the same entries, in the same order, as the list for the same filters (no filters: everything)", async () => {
        await seed();
        const calls = [];
        await withServer({ loadExportWriter: recordingWriter(calls) }, async (call) => {
            const cases = [
                {},
                { passportId: "N1023757" },
                { passportId: "n1023757" },
                { adminId: USERS.ANALYST.adminId },
                { action: "APPROVE" },
                { category: "REVIEW" },
                { category: "OTHER" },
                { startDate: "2026-11-09", endDate: "2026-11-09" },
                { startDate: "2026-11-10" },
                { search: "invite" },
                { search: "passport" },
            ];
            for (const filters of cases) {
                const query = new URLSearchParams({ ...filters, pageSize: "100" });
                const list = await call(`/audit-logs?${query}`);
                assert.equal(list.status, 200);
                const exported = await call("/audit-logs/export", { method: "POST", body: { format: "xlsx", ...filters } });
                assert.equal(exported.status, 200, JSON.stringify(filters));
                assert.deepEqual(JSON.parse(exported.text), list.body.items.map((i) => i.auditId), JSON.stringify(filters));
                assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).items)), list.body.items, "the entries as the list shows them");
                assert.equal(calls.at(-1).total, list.body.pagination.total);
            }
            // The passport ID filter ignores case, as before: both spellings.
            const both = await call("/audit-logs?passportId=N1023757");
            assert.equal(both.body.pagination.total, 2);
            assert.equal((await call("/audit-logs?passportId=X0000000")).body.pagination.total, 0);
        });
    });
});

describe("keyset batches", () => {
    test("every entry once, newest first, across batches and equal timestamps", async () => {
        const same = new Date("2026-11-10T06:00:00Z");
        const ids = [];
        for (let i = 0; i < 7; i += 1) ids.push(await entry({ createdDate: same }));
        ids.push(await entry({ createdDate: new Date("2026-11-11T06:00:00Z") }));
        ids.push(await entry({ createdDate: new Date("2026-11-09T06:00:00Z") }));
        const { where, total } = await prepareAuditLogExport({ db: prisma, params: {} });
        assert.equal(total, 9);
        const seen = [];
        for await (const item of auditLogExportItems({ db: prisma, where, batchSize: 2 })) seen.push(item.auditId);
        const expected = [ids[7], ...ids.slice(0, 7).reverse(), ids[8]];
        assert.deepEqual(seen, expected);
        const capped = [];
        for await (const item of auditLogExportItems({ db: prisma, where, batchSize: 2, limit: 3 })) capped.push(item.auditId);
        assert.deepEqual(capped, expected.slice(0, 3));
    });

    test("entries written after the export started are not included", async () => {
        await entry({ createdDate: new Date("2026-11-10T06:00:00Z") });
        const { where } = await prepareAuditLogExport({ db: prisma, params: {}, asOf: new Date("2026-11-10T07:00:00Z") });
        await entry({ createdDate: new Date("2026-11-10T08:00:00Z") });
        const seen = [];
        for await (const item of auditLogExportItems({ db: prisma, where })) seen.push(item.auditId);
        assert.equal(seen.length, 1);
    });
});

describe("export rows", () => {
    test("formula injection: text starting with = + - @ (or tab / CR) gets a leading apostrophe", () => {
        for (const value of ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\t=1", "\r=1", "=HYPERLINK(\"http://x\")"]) {
            assert.equal(spreadsheetSafe(value), `'${value}`);
        }
        for (const value of ["plain", "a=b", "", "N1023757", "1-2"]) assert.equal(spreadsheetSafe(value), value);
        assert.equal(spreadsheetSafe(5), 5);
        assert.equal(spreadsheetSafe(null), null);
    });

    test("sensitive keys stay stripped; changed fields listed one per line", async () => {
        await entry({
            passportId: "N1023757", action: "UPDATE_CANDIDATE",
            previousValue: JSON.stringify({ surname: "Old", password: "hunter2" }), newValue: JSON.stringify({ surname: "=New", sessionToken: "abc" }),
            reason: "@reason",
        });
        await entry({ action: "INVITE_USER", newValue: JSON.stringify({ email: "x@example.com", apiKey: "k" }) });
        const { where } = await prepareAuditLogExport({ db: prisma, params: {} });
        const rows = [];
        for await (const item of auditLogExportItems({ db: prisma, where })) rows.push(exportRowOf(item));
        const text = JSON.stringify(rows);
        for (const secret of ["hunter2", "password", "sessionToken", "abc\"", "apiKey"]) assert.ok(!text.includes(secret), secret);
        const update = rows.find((r) => r.action === "Update candidate");
        assert.equal(update.previousValue, "surname: Old");
        assert.equal(update.newValue, "surname: =New");
        assert.equal(update.passportId, "N1023757");
        assert.equal(update.user, "Ada Admin");
        assert.equal(update.role, "Admin");
        assert.match(update.dateTime, /^2026-11-10 11:30:00$/, "Sri Lanka time");
        assert.equal(spreadsheetSafe(update.reason), "'@reason");
        assert.equal(rows.find((r) => r.action === "Invite user").newValue, "email: x@example.com");
    });

    const collect = async (format, item) => {
        const out = new PassThrough();
        const chunks = [];
        out.on("data", (c) => chunks.push(c));
        const write = await loadAuditLogExportWriter(format);
        async function* items() { yield item; }
        await write({ items: items(), out, total: 1, generatedAt: new Date("2026-11-10T06:00:00Z") });
        return Buffer.concat(chunks);
    };
    const sample = {
        auditId: "a1", createdDate: new Date("2026-11-10T06:00:00Z"), action: "UPDATE_CANDIDATE", category: "CANDIDATE",
        actor: { userId: "u", name: "=Evil", role: "ADMIN" }, candidate: { passportId: "N1023757", uniqueId: "EM-1", name: "+Anusha" },
        documentType: null, stage: null, previousStatus: "SAVED", newStatus: "SAVED", previousValue: null, newValue: null,
        changes: [{ field: "surname", from: "Old", to: "-New" }], details: null, policeSubmittedDate: null, reason: "@x",
    };

    test("a real workbook: guarded cells, header row", { skip: !installed("exceljs") && "exceljs is not installed" }, async () => {
        const buffer = await collect("xlsx", sample);
        const { default: ExcelJS } = await import("exceljs");
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const sheet = workbook.getWorksheet("Audit log");
        assert.equal(sheet.getRow(1).getCell(1).value, "Date / time (Sri Lanka)");
        const values = sheet.getRow(2).values.filter((v) => v !== undefined && v !== null);
        assert.ok(values.includes("'=Evil") && values.includes("'+Anusha") && values.includes("'@x"), JSON.stringify(values));
        assert.ok(values.includes("surname: -New"));
        assert.ok(!values.some((v) => typeof v === "object"), "no formula cell");
    });

    test("a real PDF", { skip: !installed("pdfkit") && "pdfkit is not installed" }, async () => {
        const buffer = await collect("pdf", sample);
        assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
        assert.match(buffer.subarray(-8).toString(), /%%EOF/);
    });
});
