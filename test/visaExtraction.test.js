// Visa Submission Phase 2: eligibility, the extraction into VISA SUBMISSION/{date}/Plan B/ (PDF copies and
// the Client's two Excel files), the per-(date, Client) lock, idempotent retries, the read-only browser
// (folder list, file stream, ZIP) and the audit entries. On a REAL PostgreSQL (PGlite, every migration
// applied, including 20261124140000_visa_submission_extractions) through the real Prisma client and the real
// admin router; the storage bucket is an in-memory fake that behaves like Supabase Storage (list pages of
// 100 with folders as id null, copy refusing an existing destination, download().asStream()).
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import ExcelJS from "exceljs";
import JSZip from "jszip";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ALL_ROLES } from "../src/middleware/requireRole.js";
import { categoryOf } from "../src/services/auditLogService.js";
import { businessDateOf } from "../src/utils/businessDay.js";
import { VISA_SUBMISSION_PLAN_FOLDER, VISA_SUBMISSION_ROOT, VISA_ZIP_MAX_BYTES } from "../src/config/visaSubmission.js";
import { acquireExtractionLock, eligibleCandidates, extractBatch } from "../src/services/visaExtractionService.js";
import { CANDIDATE_DETAILS_HEADERS, EXTRA_DETAILS_HEADERS, softSkillsOf } from "../src/services/visaExtractionExcel.js";
import { clientFileNameOf, parseBrowsePath, planFolderZip } from "../src/services/visaSubmissionStorage.js";

const user = (role, n) => ({ adminId: `vx-${role.toLowerCase()}`, role, name: `${role} user`, email: `vx.${role.toLowerCase()}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n + 800).padStart(12, "0")}`, status: "ACTIVE" });
const USERS = Object.fromEntries(ALL_ROLES.map((role, n) => [role, user(role, n + 1)]));
const ALLOWED = ["OWNER", "ADMIN", "TEAM_LEAD"];
const REFUSED = ["ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"];
const pdf = (tag) => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from(String(tag)), Buffer.alloc(32, 0x20)]);
const notFound = () => ({ statusCode: "404", message: "Object not found" });

// Supabase Storage as the extraction and the browser use it. `accessed` records every key read or listed.
function createBucket() {
    const objects = new Map();
    const accessed = [];
    let id = 0;
    const bucket = {
        objects, accessed, failCopy: new Set(), failUpload: new Set(), copyGate: null, uploads: [],
        store(path, bytes, { size } = {}) { objects.set(path, { bytes, size: size ?? bytes.length, id: `obj-${++id}`, updatedAt: new Date().toISOString() }); },
        bytes: (path) => objects.get(path)?.bytes ?? null,
        async list(prefix, { limit = 100, offset = 0, search } = {}) {
            accessed.push(`list:${prefix}`);
            const base = prefix ? `${prefix}/` : "";
            const children = new Map();
            for (const [key, object] of objects) {
                if (!key.startsWith(base)) continue;
                const rest = key.slice(base.length);
                const [name, ...deeper] = rest.split("/");
                if (deeper.length) children.set(name, { name, id: null, updated_at: null, created_at: null, metadata: null });
                else children.set(name, { name, id: object.id, updated_at: object.updatedAt, created_at: object.updatedAt, metadata: { size: object.size, mimetype: "application/octet-stream" } });
            }
            let entries = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            if (search) entries = entries.filter((e) => e.name.toLowerCase().startsWith(search.toLowerCase()));
            return { data: entries.slice(offset, offset + limit), error: null };
        },
        async copy(from, to) {
            if (bucket.copyGate) await bucket.copyGate;
            if (bucket.failCopy.has(from) || !objects.has(from)) return { data: null, error: notFound() };
            if (objects.has(to)) return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
            bucket.store(to, objects.get(from).bytes);
            return { data: { path: to }, error: null };
        },
        async remove(paths) { paths.forEach((p) => objects.delete(p)); return { data: [], error: null }; },
        async upload(path, bytes, { upsert = false } = {}) {
            if ([...bucket.failUpload].some((part) => path.includes(part))) return { data: null, error: { statusCode: "500", message: "storage unavailable" } };
            if (objects.has(path) && !upsert) return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
            bucket.store(path, Buffer.from(bytes));
            bucket.uploads.push(path);
            return { data: { path }, error: null };
        },
        download(path) {
            accessed.push(`download:${path}`);
            const answer = (body) => (objects.has(path) ? { data: body(objects.get(path).bytes), error: null } : { data: null, error: notFound() });
            return {
                then: (resolve, reject) => Promise.resolve(answer((b) => b)).then(resolve, reject),
                asStream: () => Promise.resolve(answer((b) => new Blob([b]).stream())),
            };
        },
    };
    return bucket;
}

let database;
let prisma;
let pg;
let server;
let baseUrl;
let bucket;
let sequence = 0;
let jobTypeSeq = 0;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
    const app = express();
    app.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: req.get("x-test-user") }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        if (!req.user) return res.status(401).json({ message: "Invalid or Expired Token" });
        return next();
    };
    const bucketProxy = new Proxy({}, { get: (_, property) => (typeof bucket[property] === "function" ? bucket[property].bind(bucket) : bucket[property]) });
    app.use("/api/admin", createAdminRouter({ db: prisma, bucket: bucketProxy, requireAdmin, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(async () => {
    server?.close();
    await database?.close();
});
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "visa_submission_extraction"; DELETE FROM "visa_submission_extraction_lock";
        DELETE FROM "rate_limits"; DELETE FROM "job_candidate"; DELETE FROM "job_job_type"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "documents"; DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    bucket = createBucket();
});

async function api(who, method, path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "x-test-user": who.adminId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
    return { status: response.status, headers: response.headers, bytes, body: isJson ? JSON.parse(bytes.toString("utf8")) : null };
}
const ok = (response, status = 200) => {
    assert.equal(response.status, status, JSON.stringify(response.body));
    return response.body;
};

// A Job of a new Client, with job types in this order (the first is the Primary Trade).
async function createJob({ clientName = "Acme Builders", trades = ["Mason", "Carpenter"] } = {}) {
    sequence += 1;
    const agent = await prisma.agent.create({ data: { name: `VX Agent ${sequence}`, countryCode: "RO" } });
    const client = await prisma.client.create({ data: { name: clientName } });
    const job = await prisma.job.create({ data: { jobCode: `JOB-2026-${800000 + sequence}`, clientId: client.id, responsibleAgentId: agent.id, countryCode: "RO", createdById: USERS.ADMIN.adminId } });
    for (const [index, name] of trades.entries()) {
        jobTypeSeq += 1;
        const type = await prisma.jobType.findFirst({ where: { name: { equals: name, mode: "insensitive" } } })
            ?? await prisma.jobType.create({ data: { code: `VX_TYPE_${jobTypeSeq}`, name } });
        await prisma.jobJobType.create({ data: { jobId: job.id, jobTypeId: type.id, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)) } });
    }
    return job;
}

// A signed VISA_SUBMISSION document stored for the candidate; `minutesAgo` orders the uploads.
async function signedDocument(passportId, { minutesAgo = 10, status = "VERIFIED" } = {}) {
    sequence += 1;
    const bytes = pdf(`signed-${passportId}-${sequence}`);
    const documentId = crypto.randomUUID();
    const storagePath = `clients/${passportId}/visa-submission/visa_submission_v${sequence}.pdf`;
    bucket.store(storagePath, bytes);
    await prisma.document.create({
        data: {
            documentId, passportId, documentType: "VISA_SUBMISSION", originalFilename: "signed.pdf", storedFilename: `visa_submission_v${sequence}.pdf`, storagePath,
            mimeType: "application/pdf", fileSize: BigInt(bytes.length), receivedDate: new Date(Date.now() - minutesAgo * 60_000), processingStatus: "STORED",
            verificationStatus: status, fileSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        },
    });
    return { documentId, bytes, storagePath };
}

// A candidate on `job`: stage completed and a signed document unless told otherwise.
async function candidate(job, passportId, { firstName = "Nimal", otherName = "Perera", details, stage = true, document = {}, isActive = true, released = false } = {}) {
    sequence += 1;
    await prisma.candidate.create({ data: { passportId, uniqueId: `VX${sequence}`, firstName, otherName } });
    if (details) await prisma.candidateAdditionalDetails.create({ data: { passportId, ...details } });
    if (stage) await prisma.candidateStage.create({ data: { passportId, stage: "VISA_SUBMISSION", completed: true, completedAt: new Date() } });
    await prisma.jobCandidate.create({ data: { jobId: job.id, passportId, assignedBy: USERS.ADMIN.adminId, isActive: isActive && !released, releasedAt: released ? new Date() : null } });
    return document === null ? null : signedDocument(passportId, document);
}

const today = () => businessDateOf(new Date());
const folderOf = (date = today()) => `${VISA_SUBMISSION_ROOT}/${date}/${VISA_SUBMISSION_PLAN_FOLDER}`;
const extract = (who, job, passportIds) => api(who, "POST", `/visa-submission/extraction/jobs/${job.id}/extract`, { passportIds });

async function readSheet(path) {
    const bytes = bucket.bytes(path);
    assert.ok(bytes, `${path} exists`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    return workbook.worksheets[0];
}
// A row's cells 1..width ("" for an empty cell). Candidate Details has 4 columns, Extra Details 11.
const widthOf = (sheet) => (sheet.name === "Candidate Details" ? 4 : 11);
const rowValues = (sheet, r) => Array.from({ length: widthOf(sheet) }, (_, i) => sheet.getRow(r).getCell(i + 1).value ?? "");
const dataRows = (sheet, first) => {
    const rows = [];
    for (let r = first; r <= sheet.rowCount; r += 1) if (sheet.getRow(r).hasValues) rows.push(rowValues(sheet, r));
    return rows;
};

// ---------------------------------------------------------------- eligibility

describe("eligibility", () => {
    test("released excluded; inactive-but-not-released included; stage not completed, unverified and superseded excluded; ordered by upload time", async () => {
        const job = await createJob();
        await candidate(job, "P0000003", { document: { minutesAgo: 5 } });
        await candidate(job, "P0000001", { document: { minutesAgo: 30 } });
        await candidate(job, "P0000002", { isActive: false, document: { minutesAgo: 20 } });
        await candidate(job, "P0000004", { released: true });
        await candidate(job, "P0000005", { stage: false });
        await candidate(job, "P0000006", { document: { status: "REVIEW_REQUIRED" } });
        await candidate(job, "P0000007", { document: { status: "SUPERSEDED" } });
        await candidate(job, "P0000008", { document: null });

        const preview = ok(await api(USERS.ADMIN, "GET", `/visa-submission/extraction/jobs/${job.id}`));
        assert.deepEqual(preview.candidates.map((c) => c.passportId), ["P0000001", "P0000002", "P0000003"]);
        assert.equal(preview.folder, folderOf());
        assert.deepEqual(preview.files, { candidateDetails: "Candidate_Details_Acme Builders.xlsx", extraDetails: "Extra_Details_Acme Builders.xlsx" });
        assert.deepEqual(preview.skipped, []);
        assert.equal(preview.job.primaryTrade, "Mason");
        assert.deepEqual([preview.batchSize, preview.maxBatchSize], [10, 15]);
        assert.doesNotMatch(JSON.stringify(preview), /clients\//, "no storage path");

        const jobs = ok(await api(USERS.TEAM_LEAD, "GET", "/visa-submission/extraction/jobs")).jobs;
        assert.deepEqual(jobs.map((j) => [j.jobId, j.client.name, j.eligibleCount, j.primaryTrade]), [[job.id, "Acme Builders", 3, "Mason"]]);
    });

    test("already extracted excluded; a re-uploaded signed document is eligible again; a COMPLETED job still lists its eligible candidates", async () => {
        const job = await createJob();
        await candidate(job, "P0000011", { document: { minutesAgo: 30 } });
        await candidate(job, "P0000012", { document: { minutesAgo: 20 } });
        await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED", completedAt: new Date() } });
        ok(await extract(USERS.ADMIN, job, ["P0000011", "P0000012"]));
        assert.deepEqual((await eligibleCandidates(prisma, job.id)).eligible, []);
        assert.deepEqual(ok(await api(USERS.ADMIN, "GET", "/visa-submission/extraction/jobs")).jobs, [], "no eligible candidate and not PROCESSING: not listed");

        await prisma.document.updateMany({ where: { passportId: "P0000012", documentType: "VISA_SUBMISSION" }, data: { verificationStatus: "SUPERSEDED" } });
        const reupload = await signedDocument("P0000012", { minutesAgo: 1 });
        const preview = ok(await api(USERS.ADMIN, "GET", `/visa-submission/extraction/jobs/${job.id}`));
        assert.deepEqual(preview.candidates.map((c) => [c.passportId, c.documentId]), [["P0000012", reupload.documentId]]);
        assert.deepEqual(ok(await api(USERS.ADMIN, "GET", "/visa-submission/extraction/jobs")).jobs.map((j) => [j.jobId, j.status, j.eligibleCount]), [[job.id, "COMPLETED", 1]]);
    });

    test("passport numbers that differ only in letter case are skipped with a warning (both); the vacancy count is not read", async () => {
        const job = await createJob();
        await prisma.job.update({ where: { id: job.id }, data: { vacancies: 1 } });
        await candidate(job, "P0000021");
        await candidate(job, "P0000022");
        await candidate(job, "N0000023");
        await candidate(job, "n0000023");
        const preview = ok(await api(USERS.ADMIN, "GET", `/visa-submission/extraction/jobs/${job.id}`));
        assert.deepEqual(preview.candidates.map((c) => c.passportId).sort(), ["P0000021", "P0000022"]);
        assert.deepEqual(preview.skipped.map((s) => [s.passportId, s.reason]).sort(), [["N0000023", "DUPLICATE_PASSPORT_NUMBER"], ["n0000023", "DUPLICATE_PASSPORT_NUMBER"]]);
        assert.equal(ok(await api(USERS.ADMIN, "GET", "/visa-submission/extraction/jobs")).jobs[0].eligibleCount, 2, "the count applies the same checks");
    });

    test("a passport number that can't be a file name is skipped with a warning", async () => {
        const job = await createJob();
        await candidate(job, "P-0000031");
        const preview = ok(await api(USERS.ADMIN, "GET", `/visa-submission/extraction/jobs/${job.id}`));
        assert.deepEqual([preview.candidates, preview.skipped.map((s) => s.reason)], [[], ["INVALID_PASSPORT_NUMBER"]]);
    });

    test("an unknown or malformed job is 404", async () => {
        assert.equal((await api(USERS.ADMIN, "GET", `/visa-submission/extraction/jobs/${crypto.randomUUID()}`)).status, 404);
        assert.equal((await api(USERS.ADMIN, "GET", "/visa-submission/extraction/jobs/not-a-uuid")).status, 404);
    });
});

// ---------------------------------------------------------------- storage

describe("storage", () => {
    test("{passportId}.pdf is a server-side copy of the signed document; the original is untouched", async () => {
        const job = await createJob();
        const signed = await candidate(job, "P0000041");
        const answer = ok(await extract(USERS.ADMIN, job, ["P0000041"]));
        const target = `${folderOf()}/P0000041.pdf`;
        assert.deepEqual(answer.extracted, [{ passportId: "P0000041", documentId: signed.documentId, file: target }]);
        assert.ok(bucket.bytes(target).equals(signed.bytes));
        assert.ok(bucket.bytes(signed.storagePath).equals(signed.bytes), "the original stays where it was");
        const row = await prisma.visaSubmissionExtraction.findUnique({ where: { documentId: signed.documentId } });
        assert.deepEqual([row.passportId, row.jobId, row.clientName, row.storagePath, row.extractedById], ["P0000041", job.id, "Acme Builders", target, USERS.ADMIN.adminId]);
    });

    test("an existing {passportId}.pdf is replaced (Supabase's copy refuses an existing destination)", async () => {
        const job = await createJob();
        await candidate(job, "P0000042");
        bucket.store(`${folderOf()}/P0000042.pdf`, Buffer.from("old"));
        ok(await extract(USERS.ADMIN, job, ["P0000042"]));
        assert.match(bucket.bytes(`${folderOf()}/P0000042.pdf`).toString(), /^%PDF/);
    });

    test("the folder date is the Asia/Colombo business day, not UTC (around midnight)", async () => {
        const job = await createJob();
        await candidate(job, "P0000043", { document: { minutesAgo: 60 * 24 * 3 } });
        await candidate(job, "P0000044", { document: { minutesAgo: 60 * 24 * 2 } });
        // 18:29:59 UTC is 23:59:59 in Colombo; 18:30:00 UTC is already the next day there (UTC is still the 24th).
        const before = await extractBatch({ db: prisma, bucket, actor: USERS.ADMIN, jobId: job.id, passportIds: ["P0000043"], now: new Date("2026-11-24T18:29:59Z") });
        const afterMidnight = await extractBatch({ db: prisma, bucket, actor: USERS.ADMIN, jobId: job.id, passportIds: ["P0000044"], now: new Date("2026-11-24T18:30:00Z") });
        assert.deepEqual([before.date, afterMidnight.date], ["2026-11-24", "2026-11-25"]);
        assert.ok(bucket.bytes(`${folderOf("2026-11-24")}/P0000043.pdf`));
        assert.ok(bucket.bytes(`${folderOf("2026-11-25")}/P0000044.pdf`));
        assert.ok(bucket.bytes(`${folderOf("2026-11-25")}/Candidate_Details_Acme Builders.xlsx`));
    });

    test("a failed PDF copy is reported for that candidate only; nothing is recorded for it and it stays eligible", async () => {
        const job = await createJob();
        await candidate(job, "P0000045", { document: { minutesAgo: 30 } });
        const broken = await candidate(job, "P0000046", { document: { minutesAgo: 20 } });
        bucket.failCopy.add(broken.storagePath);
        const answer = ok(await extract(USERS.ADMIN, job, ["P0000045", "P0000046"]));
        assert.deepEqual(answer.extracted.map((e) => e.passportId), ["P0000045"]);
        assert.deepEqual(answer.failed, [{ passportId: "P0000046", reason: "PDF_COPY_FAILED" }]);
        assert.equal(answer.remaining, 1);
        assert.equal(await prisma.visaSubmissionExtraction.count(), 1);
        assert.deepEqual(dataRows(await readSheet(`${folderOf()}/Candidate_Details_Acme Builders.xlsx`), 2).map((r) => r[2]), ["P0000045"]);
    });

    test("client names become readable, safe file names", () => {
        assert.equal(clientFileNameOf("Acme Builders"), "Acme Builders");
        assert.equal(clientFileNameOf("Ünïon/Construct\\SRL: <RO>"), "Union Construct SRL RO");
        assert.equal(clientFileNameOf("../../clients"), "clients");
        assert.equal(clientFileNameOf("שלום"), "Client");
    });
});

// ---------------------------------------------------------------- Excel

describe("Excel", () => {
    const candidatePath = (client = "Acme Builders") => `${folderOf()}/Candidate_Details_${client}.xlsx`;
    const extraPath = (client = "Acme Builders") => `${folderOf()}/Extra_Details_${client}.xlsx`;

    test("exact headers and title, the mapping, soft skills, empty Profession and GROUP", async () => {
        const job = await createJob();
        await candidate(job, "P0000051", {
            firstName: "Kamal", otherName: "Silva", document: { minutesAgo: 30 },
            details: { tshirtSize: "L", pantSize: "32", shoeSize: "42", englishKnowledge: "GOOD", canReadDrawings: true, teamLeadingSkills: true, otherLanguages: "Tamil, Hindi" },
        });
        await candidate(job, "P0000052", { firstName: "=cmd", otherName: null, document: { minutesAgo: 20 } });
        await candidate(job, "P0000053", { firstName: "Sunil", otherName: "Fernando", document: { minutesAgo: 10 }, details: { teamLeadingSkills: false, canReadDrawings: true, englishKnowledge: "ENGLISH 9" } });
        ok(await extract(USERS.ADMIN, job, ["P0000053", "P0000051", "P0000052"]));

        const details = await readSheet(candidatePath());
        assert.deepEqual(rowValues(details, 1), [...CANDIDATE_DETAILS_HEADERS]);
        assert.deepEqual(CANDIDATE_DETAILS_HEADERS, ["First name", "Last name", "Passport number", "Profession"]);
        assert.deepEqual(dataRows(details, 2), [
            ["Kamal", "Silva", "P0000051", ""],
            ["'=cmd", "", "P0000052", ""],
            ["Sunil", "Fernando", "P0000053", ""],
        ]);

        const extra = await readSheet(extraPath());
        assert.equal(extra.getCell(1, 1).value, "EXTRA DETAIL FOR (Acme Builders)");
        assert.equal(extra.getCell(1, 1).font.bold, true);
        assert.equal(extra.getCell(1, 1).fill.fgColor.argb, "FFFFFF00");
        assert.ok(extra.getCell(1, 11).isMerged && extra.getCell(1, 11).master.address === "A1", "the title spans the table");
        assert.deepEqual(rowValues(extra, 2), [
            "GROUP", "Running No.", "Candidate's First Name", "Candidate's Last Name", "Primary Trade מקצוע ראשי", "Secondary Trade מקצוע משני / Soft skill",
            "PP No.", "Communication Skills ידע אנגלית-רמת תקשורת", "cloths size", "Pant size", "Shoe size",
        ]);
        assert.deepEqual(rowValues(extra, 2), [...EXTRA_DETAILS_HEADERS]);
        const header = extra.getCell(2, 5);
        assert.deepEqual([header.font.bold, header.font.color.argb, header.fill.fgColor.argb, header.alignment.wrapText], [true, "FFFFFFFF", "FF1F3864", true]);
        assert.deepEqual(dataRows(extra, 3), [
            ["", 1, "Kamal", "Silva", "Mason", "Can Read Drawings: Yes, Team Leading: Yes, Languages: Tamil, Hindi", "P0000051", "ENGLISH 8", "L", "32", "42"],
            ["", 2, "'=cmd", "", "Mason", "", "P0000052", "", "", "", ""],
            ["", 3, "Sunil", "Fernando", "Mason", "Can Read Drawings: Yes", "P0000053", "ENGLISH 9", "", "", ""],
        ]);
    });

    test("soft skills: only the recorded parts", () => {
        assert.equal(softSkillsOf(null), "");
        assert.equal(softSkillsOf({ canReadDrawings: false, teamLeadingSkills: null, otherLanguages: "  " }), "");
        assert.equal(softSkillsOf({ teamLeadingSkills: true, otherLanguages: "Tamil" }), "Team Leading: Yes, Languages: Tamil");
    });

    test("appending continues Running No.; a re-extraction updates the row (both files), never a duplicate", async () => {
        const job = await createJob();
        await candidate(job, "P0000061", { document: { minutesAgo: 30 } });
        await candidate(job, "P0000062", { document: { minutesAgo: 20 } });
        await candidate(job, "P0000063", { document: { minutesAgo: 10 } });
        ok(await extract(USERS.ADMIN, job, ["P0000061", "P0000062"]));
        ok(await extract(USERS.ADMIN, job, ["P0000063"]));
        assert.deepEqual(dataRows(await readSheet(extraPath()), 3).map((r) => [r[1], r[6]]), [[1, "P0000061"], [2, "P0000062"], [3, "P0000063"]]);

        // Same-day re-upload of P0000062 with new details.
        await prisma.document.updateMany({ where: { passportId: "P0000062", documentType: "VISA_SUBMISSION" }, data: { verificationStatus: "SUPERSEDED" } });
        const reupload = await signedDocument("P0000062", { minutesAgo: 1 });
        await prisma.candidate.update({ where: { passportId: "P0000062" }, data: { firstName: "Renamed" } });
        ok(await extract(USERS.ADMIN, job, ["P0000062"]));
        const extra = dataRows(await readSheet(extraPath()), 3);
        assert.deepEqual(extra.map((r) => [r[1], r[2], r[6]]), [[1, "Nimal", "P0000061"], [2, "Renamed", "P0000062"], [3, "Nimal", "P0000063"]]);
        assert.deepEqual(dataRows(await readSheet(candidatePath()), 2).map((r) => [r[0], r[2]]), [["Nimal", "P0000061"], ["Renamed", "P0000062"], ["Nimal", "P0000063"]]);
        assert.ok(bucket.bytes(`${folderOf()}/P0000062.pdf`).equals(reupload.bytes), "the PDF is the re-uploaded one");
        assert.equal(await prisma.visaSubmissionExtraction.count({ where: { passportId: "P0000062" } }), 2, "one row per extracted document");
    });

    test("one pair of files per Client", async () => {
        const first = await createJob({ clientName: "Acme Builders" });
        const second = await createJob({ clientName: "Beta Steel", trades: ["Welder"] });
        await candidate(first, "P0000071");
        await candidate(second, "P0000072");
        ok(await extract(USERS.ADMIN, first, ["P0000071"]));
        ok(await extract(USERS.ADMIN, second, ["P0000072"]));
        assert.deepEqual(dataRows(await readSheet(extraPath("Acme Builders")), 3).map((r) => [r[4], r[6]]), [["Mason", "P0000071"]]);
        assert.deepEqual(dataRows(await readSheet(extraPath("Beta Steel")), 3).map((r) => [r[1], r[4], r[6]]), [[1, "Welder", "P0000072"]]);
        assert.equal((await readSheet(extraPath("Beta Steel"))).getCell(1, 1).value, "EXTRA DETAIL FOR (Beta Steel)");
    });
});

// ---------------------------------------------------------------- concurrency and idempotency

describe("lock and retries", () => {
    test("a held lock is 409 EXTRACTION_IN_PROGRESS; an expired one is taken over", async () => {
        const job = await createJob();
        await candidate(job, "P0000081");
        const lockKey = `${today()}/Acme Builders`;
        await prisma.visaSubmissionExtractionLock.create({ data: { lockKey, holder: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
        const busy = await extract(USERS.ADMIN, job, ["P0000081"]);
        assert.deepEqual([busy.status, busy.body], [409, { message: "Extraction in progress, try again", code: "EXTRACTION_IN_PROGRESS" }]);
        assert.equal(await prisma.visaSubmissionExtraction.count(), 0);

        await prisma.visaSubmissionExtractionLock.update({ where: { lockKey }, data: { expiresAt: new Date(Date.now() - 1000) } });
        assert.equal(ok(await extract(USERS.ADMIN, job, ["P0000081"])).extracted.length, 1);
        assert.equal(await prisma.visaSubmissionExtractionLock.count(), 0, "released after the batch");
    });

    test("two requests at once for the same Client and day: the second is 409 while the first runs", async () => {
        const job = await createJob();
        await candidate(job, "P0000082");
        let open;
        bucket.copyGate = new Promise((resolve) => { open = resolve; });
        const first = extract(USERS.ADMIN, job, ["P0000082"]);
        while (!(await prisma.visaSubmissionExtractionLock.count())) await new Promise((r) => setTimeout(r, 5));
        const second = await extract(USERS.TEAM_LEAD, job, ["P0000082"]);
        assert.equal(second.status, 409);
        open();
        bucket.copyGate = null;
        assert.equal(ok(await first).extracted.length, 1);
        assert.equal(await prisma.visaSubmissionExtraction.count(), 1);
    });

    test("another Client's lock does not block", async () => {
        const job = await createJob();
        await candidate(job, "P0000083");
        assert.ok(await acquireExtractionLock(prisma, `${today()}/Someone Else`));
        assert.equal(ok(await extract(USERS.ADMIN, job, ["P0000083"])).extracted.length, 1);
    });

    test("a failed Excel update records nothing (502); the retry completes without duplicate rows; a repeated batch is skipped", async () => {
        const job = await createJob();
        await candidate(job, "P0000084", { document: { minutesAgo: 30 } });
        await candidate(job, "P0000085", { document: { minutesAgo: 20 } });
        bucket.failUpload.add("Extra_Details_");
        const failed = await extract(USERS.ADMIN, job, ["P0000084", "P0000085"]);
        assert.deepEqual([failed.status, failed.body.code], [502, "EXCEL_UPDATE_FAILED"]);
        assert.equal(await prisma.visaSubmissionExtraction.count(), 0);
        assert.equal(await prisma.visaSubmissionExtractionLock.count(), 0, "the lock is released on failure too");

        bucket.failUpload.clear();
        const retried = ok(await extract(USERS.ADMIN, job, ["P0000084", "P0000085"]));
        assert.deepEqual([retried.extracted.length, retried.remaining], [2, 0]);
        assert.deepEqual(dataRows(await readSheet(`${folderOf()}/Candidate_Details_Acme Builders.xlsx`), 2).map((r) => r[2]), ["P0000084", "P0000085"]);
        assert.deepEqual(dataRows(await readSheet(`${folderOf()}/Extra_Details_Acme Builders.xlsx`), 3).map((r) => [r[1], r[6]]), [[1, "P0000084"], [2, "P0000085"]]);

        const uploadsBefore = bucket.uploads.length;
        const again = ok(await extract(USERS.ADMIN, job, ["P0000084", "P0000085"]));
        assert.deepEqual([again.extracted, again.skipped.map((s) => s.reason)], [[], ["ALREADY_EXTRACTED", "ALREADY_EXTRACTED"]]);
        assert.equal(bucket.uploads.length, uploadsBefore, "the Excel files are not touched");
        assert.equal(await prisma.visaSubmissionExtraction.count(), 2);
    });

    test("names not eligible are skipped, never processed; the body is validated", async () => {
        const job = await createJob();
        await candidate(job, "P0000086", { released: true });
        const answer = ok(await extract(USERS.ADMIN, job, ["P0000086", "P9999999"]));
        assert.deepEqual(answer.skipped.map((s) => [s.passportId, s.reason]), [["P0000086", "NOT_ELIGIBLE"], ["P9999999", "NOT_ELIGIBLE"]]);
        assert.equal(bucket.uploads.length, 0);
        for (const body of [{}, { passportIds: [] }, { passportIds: ["a/b"] }, { passportIds: ["P1", "P1"] }, { passportIds: Array.from({ length: 16 }, (_, i) => `P${i}`) }]) {
            assert.equal((await api(USERS.ADMIN, "POST", `/visa-submission/extraction/jobs/${job.id}/extract`, body)).status, 400, JSON.stringify(body));
        }
    });

    test("removing an extracted signed document (Phase 1) still works and keeps the extraction history", async () => {
        const job = await createJob();
        const signed = await candidate(job, "P0000087");
        ok(await extract(USERS.ADMIN, job, ["P0000087"]));
        ok(await api(USERS.ADMIN, "POST", `/candidates/P0000087/documents/${signed.documentId}/remove`, { reason: "wrong file" }));
        const [row] = await prisma.visaSubmissionExtraction.findMany();
        assert.deepEqual([row.passportId, row.documentId], ["P0000087", null]);
    });
});

// ---------------------------------------------------------------- browser, downloads, security

describe("browser", () => {
    async function extractedFolder() {
        const job = await createJob();
        const signed = await candidate(job, "P0000091");
        ok(await extract(USERS.ADMIN, job, ["P0000091"]));
        return { job, signed };
    }
    const q = (path) => `?path=${encodeURIComponent(path)}`;

    test("lists folders and files below VISA SUBMISSION/ only, paginating past 100 entries", async () => {
        await extractedFolder();
        bucket.store("clients/P0000091/passport/passport.pdf", pdf("secret"));
        const root = ok(await api(USERS.ADMIN, "GET", "/visa-submission/storage"));
        assert.deepEqual(root.entries.map((e) => [e.name, e.type]), [[today(), "folder"]]);
        const plan = ok(await api(USERS.TEAM_LEAD, "GET", `/visa-submission/storage${q(`${today()}/${VISA_SUBMISSION_PLAN_FOLDER}`)}`));
        assert.deepEqual(plan.entries.map((e) => [e.name, e.type]), [["Candidate_Details_Acme Builders.xlsx", "file"], ["Extra_Details_Acme Builders.xlsx", "file"], ["P0000091.pdf", "file"]]);
        assert.ok(plan.entries.every((e) => typeof e.size === "number" && e.updatedAt));

        for (let i = 0; i < 230; i += 1) bucket.store(`${folderOf()}/X${String(i).padStart(4, "0")}.pdf`, pdf(i));
        const many = ok(await api(USERS.ADMIN, "GET", `/visa-submission/storage${q(`${today()}/${VISA_SUBMISSION_PLAN_FOLDER}`)}`));
        assert.equal(many.entries.length, 233);
        assert.equal(many.truncated, false);
        assert.equal((await api(USERS.ADMIN, "GET", `/visa-submission/storage${q("2001-01-01")}`)).status, 404);
    });

    test("traversal and anything outside the prefix is refused; clients/ is never reached", async () => {
        await extractedFolder();
        bucket.store("clients/P0000091/passport/passport.pdf", pdf("secret"));
        bucket.accessed.length = 0;
        const raws = [
            "..", "../clients", `${today()}/../../clients`, "/clients", "%2e%2e%2fclients", "%252e%252e%252fclients", "..%2fclients", "%2fclients",
            "%5cclients", "a%5c..%5cclients", "a//b", "a/", ".", `${today()}/./Plan B`, "a%00b", " a", ".emptyFolderPlaceholder", "path=a&path=b",
        ];
        for (const raw of raws) {
            for (const route of ["/visa-submission/storage", "/visa-submission/storage/file", "/visa-submission/storage/zip"]) {
                const query = raw === "path=a&path=b" ? `?${raw}` : `?path=${raw}`;
                const response = await api(USERS.ADMIN, "GET", `${route}${query}`);
                assert.deepEqual([response.status, response.body?.code], [400, "INVALID_PATH"], `${route} ${raw}`);
            }
        }
        // A path that looks like another root is only ever looked for INSIDE VISA SUBMISSION/.
        assert.equal((await api(USERS.ADMIN, "GET", `/visa-submission/storage/file${q("clients/P0000091/passport/passport.pdf")}`)).status, 404);
        assert.equal((await api(USERS.ADMIN, "GET", `/visa-submission/storage${q("clients")}`)).status, 404);
        assert.ok(bucket.accessed.length > 0 && bucket.accessed.every((a) => a.replace(/^(list|download):/, "").startsWith(VISA_SUBMISSION_ROOT)), bucket.accessed.join("\n"));
        assert.throws(() => parseBrowsePath("a\\b"), /Invalid path/);
    });

    test("a file is streamed as an attachment with safe headers, and audited", async () => {
        const { signed } = await extractedFolder();
        const response = await api(USERS.OWNER, "GET", `/visa-submission/storage/file${q(`${today()}/${VISA_SUBMISSION_PLAN_FOLDER}/P0000091.pdf`)}`);
        assert.equal(response.status, 200);
        assert.ok(response.bytes.equals(signed.bytes));
        assert.equal(response.headers.get("content-type"), "application/pdf");
        assert.match(response.headers.get("content-disposition"), /^attachment; filename="P0000091\.pdf"/);
        assert.match(response.headers.get("content-security-policy"), /sandbox/);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const xlsx = await api(USERS.ADMIN, "GET", `/visa-submission/storage/file${q(`${today()}/${VISA_SUBMISSION_PLAN_FOLDER}/Extra_Details_Acme Builders.xlsx`)}`);
        assert.equal(xlsx.status, 200);
        assert.match(xlsx.headers.get("content-disposition"), /filename\*=UTF-8''Extra_Details_Acme%20Builders\.xlsx/);
        assert.equal((await api(USERS.ADMIN, "GET", `/visa-submission/storage/file${q(`${today()}/${VISA_SUBMISSION_PLAN_FOLDER}`)}`)).status, 404, "a folder is not a file");

        const audits = await prisma.auditLog.findMany({ where: { action: "VISA_SUBMISSION_FILE_DOWNLOAD" }, orderBy: { createdDate: "asc" } });
        assert.equal(audits.length, 2);
        assert.deepEqual(JSON.parse(audits[0].newValue), { root: VISA_SUBMISSION_ROOT, path: `${today()}/${VISA_SUBMISSION_PLAN_FOLDER}/P0000091.pdf`, size: signed.bytes.length });
        assert.equal(audits[0].adminId, USERS.OWNER.adminId);
        assert.equal(categoryOf("VISA_SUBMISSION_FILE_DOWNLOAD"), "DOCUMENT");
    });

    test("a folder is streamed as a ZIP with its files; audited", async () => {
        const { signed } = await extractedFolder();
        const response = await api(USERS.ADMIN, "GET", `/visa-submission/storage/zip${q(today())}`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "application/zip");
        assert.match(response.headers.get("content-disposition"), new RegExp(`^attachment; filename="${today()}\\.zip"`));
        const zip = await JSZip.loadAsync(response.bytes);
        const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
        assert.deepEqual(names, [`${today()}/${VISA_SUBMISSION_PLAN_FOLDER}/Candidate_Details_Acme Builders.xlsx`, `${today()}/${VISA_SUBMISSION_PLAN_FOLDER}/Extra_Details_Acme Builders.xlsx`, `${today()}/${VISA_SUBMISSION_PLAN_FOLDER}/P0000091.pdf`]);
        assert.ok((await zip.file(`${today()}/${VISA_SUBMISSION_PLAN_FOLDER}/P0000091.pdf`).async("nodebuffer")).equals(signed.bytes));
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(await zip.file(`${today()}/${VISA_SUBMISSION_PLAN_FOLDER}/Extra_Details_Acme Builders.xlsx`).async("nodebuffer"));
        assert.equal(workbook.worksheets[0].getCell(1, 1).value, "EXTRA DETAIL FOR (Acme Builders)");

        const [audit] = await prisma.auditLog.findMany({ where: { action: "VISA_SUBMISSION_ZIP_DOWNLOAD" } });
        assert.deepEqual(JSON.parse(audit.newValue).files, 3);
        assert.equal((await api(USERS.ADMIN, "GET", "/visa-submission/storage/zip")).status, 400, "not the whole root");
    });

    test("a folder over the limit is 413 ZIP_TOO_LARGE before anything is streamed or audited", async () => {
        await extractedFolder();
        bucket.store(`${folderOf()}/huge.pdf`, pdf("x"), { size: VISA_ZIP_MAX_BYTES + 1 });
        bucket.accessed.length = 0;
        const response = await api(USERS.ADMIN, "GET", `/visa-submission/storage/zip${q(today())}`);
        assert.deepEqual([response.status, response.body.code], [413, "ZIP_TOO_LARGE"]);
        assert.equal(response.headers.get("content-type").includes("application/json"), true);
        assert.ok(!bucket.accessed.some((a) => a.startsWith("download:")), "no file was read");
        assert.equal(await prisma.auditLog.count({ where: { action: "VISA_SUBMISSION_ZIP_DOWNLOAD" } }), 0);
        await assert.rejects(planFolderZip({ bucket, path: today(), maxFiles: 2 }), { code: "ZIP_TOO_LARGE" });
    });
});

describe("security and audit", () => {
    test("every new route: 403 for ANALYST, REGISTRATION_DESK and JOB_HANDLER; allowed for OWNER, ADMIN and TEAM_LEAD", async () => {
        const job = await createJob();
        await candidate(job, "P0000101");
        ok(await extract(USERS.ADMIN, job, ["P0000101"]));
        const filePath = encodeURIComponent(`${today()}/${VISA_SUBMISSION_PLAN_FOLDER}/P0000101.pdf`);
        const routes = [
            ["GET", "/visa-submission/extraction/jobs"],
            ["GET", `/visa-submission/extraction/jobs/${job.id}`],
            ["POST", `/visa-submission/extraction/jobs/${job.id}/extract`, { passportIds: ["P0000101"] }],
            ["GET", "/visa-submission/storage"],
            ["GET", `/visa-submission/storage/file?path=${filePath}`],
            ["GET", `/visa-submission/storage/zip?path=${encodeURIComponent(today())}`],
        ];
        for (const [method, path, body] of routes) {
            for (const role of REFUSED) {
                const response = await api(USERS[role], method, path, body);
                assert.deepEqual([response.status, response.body], [403, { message: "Insufficient permissions" }], `${role} ${method} ${path}`);
            }
            for (const role of ALLOWED) assert.equal((await api(USERS[role], method, path, body)).status, 200, `${role} ${method} ${path}`);
        }
    });

    test("one VISA_SUBMISSION_EXTRACTION entry per batch with counts, documents and passports; no storage URL", async () => {
        const job = await createJob();
        const a = await candidate(job, "P0000111", { document: { minutesAgo: 30 } });
        const b = await candidate(job, "P0000112", { document: { minutesAgo: 20 } });
        bucket.failCopy.add(b.storagePath);
        ok(await extract(USERS.TEAM_LEAD, job, ["P0000111", "P0000112", "P0000113"]));
        const rows = await prisma.auditLog.findMany({ where: { action: "VISA_SUBMISSION_EXTRACTION" } });
        assert.equal(rows.length, 1);
        const value = JSON.parse(rows[0].newValue);
        assert.deepEqual(value, {
            jobId: job.id, jobCode: job.jobCode, client: "Acme Builders", folder: folderOf(),
            extractedCount: 1, failedCount: 1, skippedCount: 1, deferredCount: 0,
            extracted: [{ passportId: "P0000111", documentId: a.documentId }],
            failed: [{ passportId: "P0000112", reason: "PDF_COPY_FAILED" }],
        });
        assert.equal(rows[0].adminId, USERS.TEAM_LEAD.adminId);
        assert.doesNotMatch(rows[0].newValue, /https?:|token|signed|clients\//i);
        assert.equal(categoryOf("VISA_SUBMISSION_EXTRACTION"), "DOCUMENT");
        const logs = ok(await api(USERS.ADMIN, "GET", "/audit-logs?category=DOCUMENT&action=VISA_SUBMISSION_EXTRACTION"));
        assert.equal(logs.items.length, 1);
    });
});
