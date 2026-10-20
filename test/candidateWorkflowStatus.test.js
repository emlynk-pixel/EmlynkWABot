// Candidate list "Status" (STATUS-001 to 020): a status DERIVED from existing workflow data, on a REAL PostgreSQL
// (PGlite, every migration applied) through the real Prisma client, services and admin router.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { WORKFLOW_STATUS, WORKFLOW_STATUS_LABELS, deriveCandidateWorkflowStatus } from "../src/services/candidateWorkflowStatus.js";

const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANALYST: user("u-ann", "ANALYST", 4) };
const P = "P0000001";
const Q = "P0000002";

let database;
let prisma;
let pg;
let ids;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
    // The Candidate Form's table exists only where its migrations ran (the shared database), not in this branch's
    // migrations. A minimal copy of its shape lets the tests cover both cases: present, and absent.
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DROP TABLE IF EXISTS "candidate_form_access";
        DELETE FROM "rate_limits"; DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "job_type"; DELETE FROM "client"; DELETE FROM "agent"; DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_verification";
        DELETE FROM "documents"; DELETE FROM "candidate_call_logs"; DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        -- The active job types this suite's candidates use (Settings > Job Types).
        INSERT INTO "job_type" ("code", "name") VALUES ('COOK_SEED', 'Cook') ON CONFLICT DO NOTHING; -- ("Welder" is created below)
    `);
    await prisma.candidate.createMany({ data: [{ passportId: P, uniqueId: "7001", firstName: "Nimal", otherName: "Perera", nic: "900000001V" }, { passportId: Q, uniqueId: "7002", firstName: "Kamal", otherName: "Silva", nic: "900000002V" }] });
    const jobType = await prisma.jobType.create({ data: { code: "WELDER", name: "Welder" } });
    const agent = await prisma.agent.create({ data: { name: "Ion Popescu", countryCode: "RO" } });
    const acme = await prisma.client.create({ data: { name: "Acme Builders", agentId: agent.id } });
    ids = { jobType: jobType.id, acme: acme.id };
});

async function api(who, method, urlPath, body) {
    const app = express();
    app.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: who.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    app.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin${urlPath}`, {
            method,
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    } finally {
        server.close();
    }
}

const statusOf = async (passportId = P, who = USERS.ADMIN) => {
    const response = await api(who, "GET", `/candidates?search=${passportId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.items.find((item) => item.passportId === passportId).workflowStatus;
};
const code = async (passportId = P) => (await statusOf(passportId)).code;
const setResult = (passportId, testResult) => api(USERS.ADMIN, "PUT", `/candidates/${passportId}/stages/TEST_DETAILS`, { testResult });
const createJob = async () => (await api(USERS.MANAGER, "POST", "/jobs", { jobTypeId: ids.jobType, clientId: ids.acme })).body;
const assignJob = async (passportId = P) => {
    const job = await createJob();
    const response = await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/candidates`, { passportId });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return job;
};
const submitForm = async (passportId = P) => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS "candidate_form_access" ("passport_id" TEXT PRIMARY KEY, "status" TEXT NOT NULL DEFAULT 'LOCKED', "submitted_at" TIMESTAMP(3))`);
    await pg.exec(`INSERT INTO "candidate_form_access" ("passport_id","status","submitted_at") VALUES ('${passportId}','SUBMITTED', now()) ON CONFLICT ("passport_id") DO UPDATE SET "status"='SUBMITTED', "submitted_at"=now()`);
};
let documentCounter = 0;
const addDocument = (passportId, documentType, verificationStatus = "VERIFIED", documentVariant = null) => prisma.document.create({
    data: {
        documentId: `doc-${++documentCounter}`, passportId, documentType, documentVariant, originalFilename: "f.pdf", storedFilename: "f.pdf", storagePath: `p/${documentCounter}.pdf`,
        receivedDate: new Date(), processingStatus: "PROCESSED", verificationStatus,
    },
});
const REQUIRED = [["PASSPORT"], ["MEDICAL"], ["SCAN"], ["POLICE_REPORT", "SL_VERIFIED"], ["POLICE_REPORT", "ROMANIA"]];
const addAllDocuments = async (passportId = P, verificationStatus = "VERIFIED") => { for (const [type, variant] of REQUIRED) await addDocument(passportId, type, verificationStatus, variant ?? null); };
// Everything the Candidate details stage needs (the passport document is added with the documents).
const completeCandidateDetails = (passportId = P) => prisma.candidate.update({
    where: { passportId },
    data: { passportIssueDate: new Date("2020-01-01"), passportExpiryDate: new Date("2030-01-01"), job: "Welder", jobExperience: "5 years", whatsappNumber: `9477000${passportId.slice(-4)}` },
});
const addAdditionalDetails = (passportId = P) => prisma.candidateAdditionalDetails.create({ data: { passportId } });
const completeStage = (passportId, stage) => api(USERS.ADMIN, "PUT", `/candidates/${passportId}/stages/${stage}`, { completed: true });

describe("the central derivation (STATUS-013 and the ladder)", () => {
    test("labels and codes are stable and complete", () => {
        assert.deepEqual(Object.values(WORKFLOW_STATUS_LABELS), ["Registered", "Stopped with Test", "Job Assigned", "Form Submitted", "Details Verified", "Documents Verified", "Visa Document Ready"]);
        assert.deepEqual(Object.keys(WORKFLOW_STATUS), Object.keys(WORKFLOW_STATUS_LABELS));
    });

    test("the highest satisfied status wins; FAIL stops everything; a missing signal is false", () => {
        const d = (signals) => deriveCandidateWorkflowStatus(signals).code;
        assert.equal(d({}), "REGISTERED");
        assert.equal(d(), "REGISTERED");
        assert.equal(d({ hasCurrentJob: true }), "JOB_ASSIGNED");
        assert.equal(d({ hasCurrentJob: true, formSubmitted: true }), "FORM_SUBMITTED");
        assert.equal(d({ hasCurrentJob: true, formSubmitted: true, detailsVerified: true }), "DETAILS_VERIFIED");
        assert.equal(d({ detailsVerified: true, documentsVerified: true }), "DOCUMENTS_VERIFIED");
        assert.equal(d({ detailsVerified: true, documentsVerified: true, documentSubmissionCompleted: true }), "VISA_DOCUMENT_READY");
        assert.equal(d({ documentSubmissionCompleted: true }), "VISA_DOCUMENT_READY", "independent signals: the highest wins");
        const everything = { hasCurrentJob: true, formSubmitted: true, detailsVerified: true, documentsVerified: true, documentSubmissionCompleted: true };
        assert.equal(d({ ...everything, testResult: "FAIL" }), "STOPPED_WITH_TEST");
        for (const testResult of ["PASS", null, undefined]) assert.equal(d({ ...everything, testResult }), "VISA_DOCUMENT_READY");
        assert.deepEqual(deriveCandidateWorkflowStatus({ testResult: "FAIL" }), { code: "STOPPED_WITH_TEST", label: "Stopped with Test" });
        // The old signal names mean nothing any more.
        assert.equal(d({ visaDocumentReady: true }), "REGISTERED");
    });
});

describe("registered, stopped with test, job assigned (STATUS-001 to 005, 014, 015)", () => {
    test("STATUS-001 / 014: a new candidate with no Job, form or verification is Registered", async () => {
        assert.deepEqual(await statusOf(), { code: "REGISTERED", label: "Registered" });
        assert.equal(await code(Q), "REGISTERED");
    });

    test("STATUS-002: a saved FAIL is Stopped with Test; PASS or no result is not", async () => {
        await setResult(P, "FAIL");
        assert.deepEqual(await statusOf(), { code: "STOPPED_WITH_TEST", label: "Stopped with Test" });
        await setResult(P, "PASS");
        assert.equal(await code(), "REGISTERED");
        assert.equal(await code(Q), "REGISTERED", "no test row at all");
    });

    test("Stopped with Test uses the saved result, not stage completion: completed with no result, or PASS, is not stopped", async () => {
        await completeStage(P, "TEST_DETAILS");
        assert.equal(await code(), "REGISTERED");
    });

    test("STATUS-003 / 004 / 005: FAIL overrides a current Job; back to PASS the Job shows again", async () => {
        await setResult(P, "PASS");
        await assignJob();
        assert.equal(await code(), "JOB_ASSIGNED");
        await setResult(P, "FAIL");
        assert.equal(await code(), "STOPPED_WITH_TEST", "the Job stays assigned, the status says stopped");
        assert.equal(await prisma.jobCandidate.count({ where: { passportId: P, isActive: true } }), 1);
        await setResult(P, "PASS");
        assert.deepEqual(await statusOf(), { code: "JOB_ASSIGNED", label: "Job Assigned" });
    });

    test("only a CURRENT Job counts: a completed Job, a removed candidate and legacy job_id / candidate.job text are Registered", async () => {
        await setResult(P, "PASS");
        const job = await assignJob();
        await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`, {});
        assert.equal(await code(), "REGISTERED");
        await prisma.candidateStage.upsert({ where: { passportId_stage: { passportId: Q, stage: "TEST_DETAILS" } }, create: { passportId: Q, stage: "TEST_DETAILS", jobId: "Legacy-Job-1" }, update: { jobId: "Legacy-Job-1" } });
        await prisma.candidate.update({ where: { passportId: Q }, data: { job: "Welder" } });
        assert.equal(await code(Q), "REGISTERED");
    });

    test("STATUS-020: the PASS-before-Job rule is intact: a FAIL (Stopped with Test) candidate cannot be newly assigned", async () => {
        await setResult(P, "FAIL");
        const job = await createJob();
        const refused = await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/candidates`, { passportId: P });
        assert.deepEqual([refused.status, refused.body.code], [409, "CANDIDATE_TEST_NOT_PASSED"]);
        assert.equal(await code(), "STOPPED_WITH_TEST");
    });

    test("STATUS-015: a legacy candidate with almost no data loads safely", async () => {
        await pg.exec(`INSERT INTO "candidate" ("passport_id","unique_id","first_name","updated_date") VALUES ('L0000001','9001','Legacy', now())`);
        await pg.exec(`INSERT INTO "candidate_stages" ("passport_id","stage","job_id","updated_at") VALUES ('L0000001','TEST_DETAILS','Job12', now())`);
        const response = await api(USERS.ADMIN, "GET", "/candidates?search=L0000001");
        assert.equal(response.status, 200);
        assert.equal(response.body.items[0].workflowStatus.code, "REGISTERED");
    });
});

describe("form submitted (STATUS-006, 007)", () => {
    test("STATUS-006: a submitted Candidate Form is Form Submitted; a locked or unlocked one is not", async () => {
        await pg.exec(`CREATE TABLE "candidate_form_access" ("passport_id" TEXT PRIMARY KEY, "status" TEXT NOT NULL DEFAULT 'LOCKED', "submitted_at" TIMESTAMP(3))`);
        await pg.exec(`INSERT INTO "candidate_form_access" ("passport_id","status") VALUES ('${P}','UNLOCKED'), ('${Q}','LOCKED')`);
        assert.deepEqual([await code(), await code(Q)], ["REGISTERED", "REGISTERED"]);
        await submitForm(P);
        assert.deepEqual(await statusOf(), { code: "FORM_SUBMITTED", label: "Form Submitted" });
        assert.equal(await code(Q), "REGISTERED");
    });

    test("STATUS-007: Form Submitted overrides Job Assigned, and FAIL still overrides it", async () => {
        await setResult(P, "PASS");
        await assignJob();
        await submitForm();
        assert.equal(await code(), "FORM_SUBMITTED");
        await setResult(P, "FAIL");
        assert.equal(await code(), "STOPPED_WITH_TEST");
    });

    test("where the Candidate Form table does not exist at all (this branch's migrations) the list works and nobody is Form Submitted", async () => {
        assert.equal((await pg.query(`SELECT to_regclass('public.candidate_form_access') AS t`)).rows[0].t, null);
        assert.equal(await code(), "REGISTERED");
        const list = await api(USERS.ADMIN, "GET", "/candidates");
        assert.equal(list.status, 200);
        assert.equal(list.body.pagination.total, 2);
    });
});

describe("details and documents need an explicit manual verification; Visa Document Ready = Document submission complete (STATUS-FIX-001 to 012)", () => {
    const verify = (passportId, kind, verified = true, who = USERS.MANAGER) => api(who, "POST", `/candidates/${passportId}/verification`, { kind, verified });
    const audit = (action) => prisma.auditLog.findMany({ where: { action }, orderBy: { createdDate: "asc" } });
    // The documents Document submission needs, besides the passport: medical, scan, SL Verified and Romania police reports.
    const completeDocumentSubmission = async (passportId = P, verificationStatus = "VERIFIED") => {
        for (const [type, variant] of REQUIRED.slice(1)) await addDocument(passportId, type, verificationStatus, variant ?? null);
    };

    test("STATUS-FIX-001 / 002: completing the Candidate details, and saving Additional details, do NOT make Details Verified", async () => {
        await completeCandidateDetails();
        await addDocument(P, "PASSPORT", "REVIEW_REQUIRED");
        assert.equal((await api(USERS.ADMIN, "GET", `/candidates/${P}`)).body.stages.find((s) => s.stage === "CANDIDATE_DETAILS").completed, true, "the details stage is complete");
        assert.equal(await code(), "REGISTERED");
        await addAdditionalDetails();
        assert.equal(await code(), "REGISTERED", "additional details saved, still not verified");
        await submitForm();
        assert.equal(await code(), "FORM_SUBMITTED", "nothing between complete data and verification");
    });

    test("STATUS-FIX-003 / 004: the explicit Verify details action makes Details Verified (over Form Submitted) and is audited; removing it steps back", async () => {
        await completeCandidateDetails();
        await addDocument(P, "PASSPORT", "REVIEW_REQUIRED");
        await submitForm();
        const response = await verify(P, "DETAILS");
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.deepEqual(await statusOf(), { code: "DETAILS_VERIFIED", label: "Details Verified" });
        assert.equal(response.body.verification.details.by, USERS.MANAGER.name);
        assert.equal(response.body.verification.documents, null);
        const [entry] = await audit("VERIFY_DETAILS");
        assert.deepEqual([entry.adminId, entry.passportId, entry.previousStatus, entry.newStatus], [USERS.MANAGER.adminId, P, "NOT_VERIFIED", "VERIFIED"]);
        assert.ok(entry.createdDate);
        // Repeating it changes and audits nothing.
        await verify(P, "DETAILS");
        assert.equal((await audit("VERIFY_DETAILS")).length, 1);
        // Removing the verification steps the status back and is audited.
        assert.equal((await verify(P, "DETAILS", false)).status, 200);
        assert.equal(await code(), "FORM_SUBMITTED");
        assert.deepEqual((await audit("UNVERIFY_DETAILS")).map((e) => [e.previousStatus, e.newStatus]), [["VERIFIED", "NOT_VERIFIED"]]);
    });

    test("only ADMIN and MANAGER can verify; incomplete details cannot be verified; the row is a real manual record", async () => {
        await completeCandidateDetails();
        await addDocument(P, "PASSPORT");
        for (const who of [USERS.ANALYST, USERS.DESK]) assert.equal((await verify(P, "DETAILS", true, who)).status, 403, who.role);
        assert.equal((await verify(P, "DETAILS", true, USERS.ADMIN)).status, 200);
        const incomplete = await verify(Q, "DETAILS");
        assert.deepEqual([incomplete.status, incomplete.body.code], [409, "DETAILS_INCOMPLETE"]);
        assert.equal(await prisma.candidateVerification.count(), 1);
        for (const body of [{}, { kind: "OTHER", verified: true }, { kind: "DETAILS" }, { kind: "DETAILS", verified: "yes" }]) assert.equal((await api(USERS.ADMIN, "POST", `/candidates/${P}/verification`, body)).status, 400, JSON.stringify(body));
        assert.equal((await api(USERS.ADMIN, "POST", "/candidates/NOPE00001/verification", { kind: "DETAILS", verified: true })).status, 404);
        const row = await prisma.candidateVerification.findUnique({ where: { passportId: P } });
        assert.deepEqual([row.detailsVerifiedById, row.documentsVerifiedAt], [USERS.ADMIN.adminId, null]);
    });

    test("STATUS-FIX-005 / 006: uploaded documents, and an OCR-accepted (automatically VERIFIED) document, are NOT Documents Verified", async () => {
        await addDocument(P, "PASSPORT", "REVIEW_REQUIRED");
        await addDocument(P, "MEDICAL", "VERIFIED");
        assert.equal(await code(), "REGISTERED", "one is waiting for review, one was accepted by the OCR: neither was verified by a person");
        assert.equal(await prisma.candidateVerification.count(), 0);
        // Even every required document with the automatic VERIFIED status, the stage-based status applies and
        // Documents Verified does not (the verification row does not exist).
        await completeDocumentSubmission();
        assert.equal(await code(), "VISA_DOCUMENT_READY", "Document submission is complete");
        assert.equal((await api(USERS.ADMIN, "GET", `/candidates/${P}`)).body.verification.documents, null);
    });

    test("STATUS-FIX-007: an explicit Verify documents action makes Documents Verified (over Details Verified) and is audited; it needs a document on record", async () => {
        const nothing = await verify(P, "DOCUMENTS");
        assert.deepEqual([nothing.status, nothing.body.code], [409, "DOCUMENTS_MISSING"]);
        await completeCandidateDetails();
        await addDocument(P, "PASSPORT", "VERIFIED");
        await addDocument(P, "MEDICAL", "REVIEW_REQUIRED");
        await verify(P, "DETAILS");
        assert.equal(await code(), "DETAILS_VERIFIED");
        const response = await verify(P, "DOCUMENTS");
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.deepEqual(await statusOf(), { code: "DOCUMENTS_VERIFIED", label: "Documents Verified" });
        assert.equal(response.body.verification.documents.by, USERS.MANAGER.name);
        const [entry] = await audit("VERIFY_DOCUMENTS");
        assert.deepEqual([entry.adminId, entry.previousStatus, entry.newStatus], [USERS.MANAGER.adminId, "NOT_VERIFIED", "VERIFIED"]);
        await verify(P, "DOCUMENTS", false);
        assert.equal(await code(), "DETAILS_VERIFIED");
        assert.equal((await audit("UNVERIFY_DOCUMENTS")).length, 1);
        // A superseded document is not something to verify.
        const other = await verify(Q, "DOCUMENTS");
        assert.equal(other.status, 409);
    });

    test("STATUS-FIX-008 / 009: Document submission completed = Visa Document Ready; the Visa submission stage is not needed", async () => {
        await addDocument(P, "PASSPORT");
        await completeDocumentSubmission(P, "REVIEW_REQUIRED");
        const stages = (await api(USERS.ADMIN, "GET", `/candidates/${P}`)).body.stages;
        assert.equal(stages.find((s) => s.stage === "DOCUMENT_SUBMISSION").completed, true);
        assert.equal(stages.find((s) => s.stage === "VISA_SUBMISSION").completed, false, "Visa submission is not completed");
        assert.deepEqual(await statusOf(), { code: "VISA_DOCUMENT_READY", label: "Visa Document Ready" });
        // Completing the Visa submission stage changes nothing, and is not required.
        await completeStage(P, "VISA_SUBMISSION");
        assert.equal(await code(), "VISA_DOCUMENT_READY");
        // Only Visa submission (without Document submission) is not Visa Document Ready.
        await completeStage(Q, "VISA_SUBMISSION");
        assert.equal(await code(Q), "REGISTERED");
        // A document missing again steps back down.
        await prisma.document.updateMany({ where: { passportId: P, documentType: "SCAN" }, data: { verificationStatus: "SUPERSEDED" } });
        assert.equal(await code(), "REGISTERED");
    });

    test("Visa Document Ready outranks Documents Verified, Details Verified, Form Submitted and Job Assigned (the specified ladder)", async () => {
        await setResult(P, "PASS");
        await completeCandidateDetails();
        await addDocument(P, "PASSPORT");
        await assignJob();
        await submitForm();
        await verify(P, "DETAILS");
        await verify(P, "DOCUMENTS");
        assert.equal(await code(), "DOCUMENTS_VERIFIED");
        await completeDocumentSubmission();
        assert.equal(await code(), "VISA_DOCUMENT_READY");
    });

    test("STATUS-FIX-010 / 011: FAIL overrides every later milestone, and PASS restores the latest applicable status", async () => {
        await completeCandidateDetails();
        await addDocument(P, "PASSPORT");
        await completeDocumentSubmission();
        await submitForm();
        await verify(P, "DETAILS");
        await verify(P, "DOCUMENTS");
        assert.equal(await code(), "VISA_DOCUMENT_READY");
        await setResult(P, "FAIL");
        assert.equal(await code(), "STOPPED_WITH_TEST");
        // Every verification is still on record while stopped.
        assert.equal(await prisma.candidateVerification.count({ where: { passportId: P, detailsVerifiedAt: { not: null }, documentsVerifiedAt: { not: null } } }), 1);
        await setResult(P, "PASS");
        assert.equal(await code(), "VISA_DOCUMENT_READY");
        // A required document changes (superseded): Document submission is incomplete again and the documents sign-off
        // is reset, so the latest valid status is the details sign-off. FAIL / PASS around it changes nothing else.
        await prisma.document.updateMany({ where: { passportId: P, documentType: "SCAN" }, data: { verificationStatus: "SUPERSEDED" } });
        await setResult(P, "FAIL");
        assert.equal(await code(), "STOPPED_WITH_TEST");
        await setResult(P, "PASS");
        assert.equal(await code(), "DETAILS_VERIFIED");
    });

    test("STATUS-FIX-012: the candidate details API keeps its stages and progress data exactly; only the verification state is added", async () => {
        const body = (await api(USERS.ADMIN, "GET", `/candidates/${P}`)).body;
        assert.deepEqual(body.stages.map((s) => s.stage), ["TEST_DETAILS", "JOB_DETAILS", "CANDIDATE_DETAILS", "DOCUMENT_SUBMISSION", "IVS_INTERVIEW", "VISA_SUBMISSION", "VISA_APPROVAL", "FINALIZING_JOB"]);
        assert.deepEqual(body.verification, { details: null, documents: null });
        assert.equal(Object.hasOwn(body, "workflowStatus"), false, "the status lives on the list only");
    });

    test("the verification table is backend-only (RLS on, no API-role grants) and exists once per candidate", async () => {
        assert.equal((await pg.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'candidate_verification'`)).rows[0].relrowsecurity, true);
        assert.equal((await pg.query(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee IN ('anon','authenticated') AND table_name = 'candidate_verification'`)).rows[0].n, 0);
        await assert.rejects(pg.exec(`INSERT INTO candidate_verification (passport_id, details_verified_at) VALUES ('${P}', now())`), "an at without a by is refused");
    });
});

describe("a verification resets when the data it covers changes (VERIFY-RESET-001 to 014)", () => {
    const completeDocumentSubmission = async (passportId = P) => { for (const [type, variant] of REQUIRED.slice(1)) await addDocument(passportId, type, "VERIFIED", variant ?? null); };
    const verify = (passportId, kind, verified = true, who = USERS.MANAGER) => api(who, "POST", `/candidates/${passportId}/verification`, { kind, verified });
    const audit = (action) => prisma.auditLog.findMany({ where: { action }, orderBy: { createdDate: "asc" } });
    const verification = (passportId = P) => prisma.candidateVerification.findUnique({ where: { passportId } });
    // The full body the Candidate details form sends.
    const detailsBody = (extra = {}) => ({ surname: "Perera", otherNames: "Nimal", nic: "900000001V", address: "Colombo", jobTypes: ["Welder"], jobExperience: "5 years", passportIssueDate: "2020-01-01", passportExpiryDate: "2030-01-01", dateOfBirth: "1990-01-01", whatsappNumber: "94770000001", ...extra });
    const editDetails = (extra, who = USERS.ADMIN, passportId = P) => api(who, "PUT", `/candidates/${passportId}`, detailsBody(extra));
    const saveAdditional = (body, who = USERS.ADMIN) => api(who, "PUT", `/candidates/${P}/additional-details`, body);
    const verifiedDetails = async () => {
        await completeCandidateDetails();
        await addDocument(P, "PASSPORT");
        assert.equal((await editDetails({})).status, 200);
        assert.equal((await verify(P, "DETAILS")).status, 200);
        assert.equal(await code(), "DETAILS_VERIFIED");
    };
    const verifiedDocuments = async () => {
        await addDocument(P, "PASSPORT", "REVIEW_REQUIRED");
        assert.equal((await verify(P, "DOCUMENTS")).status, 200);
        assert.equal(await code(), "DOCUMENTS_VERIFIED");
    };
    const cleared = async (kind) => (await verification()) && (await verification())[kind === "DETAILS" ? "detailsVerifiedAt" : "documentsVerifiedAt"] === null;

    test("VERIFY-RESET-001: changing a Candidate details field clears Details Verified, the edit succeeds, and the status falls back", async () => {
        await verifiedDetails();
        await submitForm();
        const edited = await editDetails({ address: "Kandy" });
        assert.equal(edited.status, 200, JSON.stringify(edited.body));
        assert.equal(edited.body.candidate.address, "Kandy", "the edit itself succeeded");
        assert.deepEqual(edited.body.verification, { details: null, documents: null }, "the response already shows it cleared");
        assert.equal(await cleared("DETAILS"), true);
        assert.equal((await verification()).detailsVerifiedById, null);
        assert.equal(await code(), "FORM_SUBMITTED", "falls back to the next status that applies");
    });

    test("every material Candidate details value clears it (name, NIC, dates, contact, job, experience, address, nationality, sex ...)", async () => {
        const changes = [{ surname: "Silva" }, { otherNames: "Kamal" }, { nic: "900000009V" }, { address: "Galle" }, { jobTypes: ["Welder", "Cook"] }, { jobExperience: "8 years" },
            { passportIssueDate: "2021-01-01" }, { passportExpiryDate: "2031-01-01" }, { dateOfBirth: "1991-02-02" }, { contactNumber: "0112345678" }, { nationality: "Sri Lankan" }, { sex: "M" }, { placeOfBirth: "Kandy" }];
        for (const change of changes) {
            await pg.exec(`UPDATE candidate_verification SET details_verified_at = NULL, details_verified_by = NULL`);
            await verifiedDetails().catch(() => null);
            await pg.exec(`INSERT INTO candidate_verification (passport_id, details_verified_at, details_verified_by) VALUES ('${P}', now(), '${USERS.MANAGER.adminId}') ON CONFLICT (passport_id) DO UPDATE SET details_verified_at = now(), details_verified_by = '${USERS.MANAGER.adminId}'`);
            const response = await editDetails(change);
            assert.equal(response.status, 200, JSON.stringify(change) + JSON.stringify(response.body));
            assert.equal(await cleared("DETAILS"), true, JSON.stringify(change));
        }
    });

    test("saving the same values again (nothing changed) does not reset", async () => {
        await verifiedDetails();
        assert.equal((await editDetails({})).status, 200);
        assert.equal((await editDetails({ comment: "a comment is a stage note, not a detail" })).status, 200);
        assert.equal(await cleared("DETAILS"), false);
        assert.equal(await code(), "DETAILS_VERIFIED");
        assert.equal((await audit("DETAILS_VERIFICATION_RESET")).length, 0);
    });

    test("VERIFY-RESET-002: saving or changing an Additional details value clears Details Verified", async () => {
        await verifiedDetails();
        const first = await saveAdditional({ nameAsInPassport: "NIMAL PERERA" });
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal(await cleared("DETAILS"), true, "a first save of additional details");
        await verify(P, "DETAILS");
        assert.equal(await code(), "DETAILS_VERIFIED");
        const stored = (await api(USERS.ADMIN, "GET", `/candidates/${P}/additional-details`)).body;
        const second = await saveAdditional({ nameAsInPassport: "NIMAL PERERA", pantSize: "32", expectedUpdatedDate: stored.updatedDate });
        assert.equal(second.status, 200, JSON.stringify(second.body));
        assert.equal(await cleared("DETAILS"), true, "a change of an existing value");
        await verify(P, "DETAILS");
        // The same values again: no change.
        const again = (await api(USERS.ADMIN, "GET", `/candidates/${P}/additional-details`)).body;
        await saveAdditional({ nameAsInPassport: "NIMAL PERERA", pantSize: "32", expectedUpdatedDate: again.updatedDate });
        assert.equal(await cleared("DETAILS"), false);
    });

    test("VERIFY-RESET-003: unrelated changes keep Details Verified (test result, Job assignment and change, call log, other stages, documents, visa stages)", async () => {
        await verifiedDetails();
        await setResult(P, "PASS");
        const job = await assignJob();
        await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`, {});
        await assignJob();
        await api(USERS.ADMIN, "POST", `/candidates/${P}/call-logs`, { note: "Called" });
        for (const stage of ["JOB_DETAILS", "IVS_INTERVIEW", "VISA_SUBMISSION", "VISA_APPROVAL", "FINALIZING_JOB"]) assert.equal((await completeStage(P, stage)).status, 200, stage);
        await api(USERS.ADMIN, "PUT", `/candidates/${P}/stages/CANDIDATE_DETAILS`, { notes: "A stage comment" });
        await addDocument(P, "NIC");
        await addDocument(P, "VISA_SUBMISSION");
        await setResult(P, "FAIL");
        await setResult(P, "PASS");
        assert.equal(await cleared("DETAILS"), false);
        assert.equal((await audit("DETAILS_VERIFICATION_RESET")).length, 0);
    });

    test("VERIFY-RESET-004: editing details that were never verified (or already reset) writes no reset audit", async () => {
        await completeCandidateDetails();
        await addDocument(P, "PASSPORT");
        assert.equal((await editDetails({ address: "Somewhere" })).status, 200);
        assert.equal((await editDetails({ address: "Elsewhere" })).status, 200);
        assert.equal(await prisma.candidateVerification.count(), 0, "no verification row was created by an edit");
        await verify(P, "DETAILS");
        await editDetails({ address: "Again" });
        await editDetails({ address: "And again" });
        assert.equal((await audit("DETAILS_VERIFICATION_RESET")).length, 1, "one entry, for the one verification that was cleared");
    });

    test("VERIFY-RESET-005: a new required document clears Documents Verified (and only a required type)", async () => {
        await verifiedDocuments();
        await addDocument(P, "NIC");
        await addDocument(P, "SKILL_VIDEO");
        await addDocument(P, "POLICE_SLIP");
        assert.equal(await cleared("DOCUMENTS"), false, "other document types do not count");
        await addDocument(P, "MEDICAL", "REVIEW_REQUIRED");
        assert.equal(await cleared("DOCUMENTS"), true);
        assert.equal(await code(), "REGISTERED");
    });

    test("VERIFY-RESET-006: replacing or re-uploading a required document clears it (a new version, the old one superseded, a review approval)", async () => {
        await verifiedDocuments();
        const first = await prisma.document.findFirst({ where: { passportId: P, documentType: "PASSPORT" } });
        await prisma.document.update({ where: { documentId: first.documentId }, data: { verificationStatus: "SUPERSEDED" } });
        assert.equal(await cleared("DOCUMENTS"), true, "the old document was superseded");
        await verify(P, "DOCUMENTS").then((r) => assert.equal(r.status, 409), () => null);
        await addDocument(P, "PASSPORT", "VERIFIED");
        await verify(P, "DOCUMENTS");
        assert.equal(await cleared("DOCUMENTS"), false);
        // A review approval: REVIEW_REQUIRED -> VERIFIED on a required document.
        const review = await addDocument(P, "SCAN", "REVIEW_REQUIRED");
        await verify(P, "DOCUMENTS");
        await prisma.document.update({ where: { documentId: review.documentId }, data: { verificationStatus: "VERIFIED" } });
        assert.equal(await cleared("DOCUMENTS"), true, "the review state of a required document changed");
        // A different file under the same record.
        await verify(P, "DOCUMENTS");
        await prisma.document.update({ where: { documentId: review.documentId }, data: { storagePath: "new/path.pdf" } });
        assert.equal(await cleared("DOCUMENTS"), true);
    });

    test("VERIFY-RESET-007: removing a required document clears it; removing another type does not", async () => {
        await verifiedDocuments();
        const nic = await addDocument(P, "NIC");
        await prisma.document.delete({ where: { documentId: nic.documentId } });
        assert.equal(await cleared("DOCUMENTS"), false);
        const passport = await prisma.document.findFirst({ where: { passportId: P, documentType: "PASSPORT" } });
        await prisma.document.delete({ where: { documentId: passport.documentId } });
        assert.equal(await cleared("DOCUMENTS"), true);
        // Through the real admin route (audited with the actor).
        const scan = await prisma.document.create({ data: { documentId: crypto.randomUUID(), passportId: P, documentType: "SCAN", originalFilename: "f.pdf", storedFilename: "f.pdf", storagePath: "p/scan-route.pdf", receivedDate: new Date(), processingStatus: "PROCESSED", verificationStatus: "VERIFIED" } });
        await verify(P, "DOCUMENTS");
        const removed = await api(USERS.MANAGER, "POST", `/candidates/${P}/documents/${scan.documentId}/remove`, { reason: "Wrong file" });
        assert.equal(removed.status, 200, JSON.stringify(removed.body));
        assert.equal(await cleared("DOCUMENTS"), true);
        const [entry] = await audit("DOCUMENTS_VERIFICATION_RESET");
        assert.equal(entry.adminId, USERS.MANAGER.adminId, "the person who removed the document");
    });

    test("VERIFY-RESET-008: editing Candidate details does not reset Documents Verified (and details edits do not touch documents)", async () => {
        await addDocument(P, "PASSPORT");
        await completeCandidateDetails();
        await verify(P, "DOCUMENTS");
        await verify(P, "DETAILS");
        await editDetails({ address: "Moved" });
        const row = await verification();
        assert.equal(row.detailsVerifiedAt, null);
        assert.notEqual(row.documentsVerifiedAt, null, "Documents Verified stays");
        assert.equal(await code(), "DOCUMENTS_VERIFIED");
    });

    test("job, test and note changes do not reset Documents Verified", async () => {
        await verifiedDocuments();
        await setResult(P, "PASS");
        await completeStage(P, "VISA_SUBMISSION");
        await api(USERS.ADMIN, "PUT", `/candidates/${P}/stages/DOCUMENT_SUBMISSION`, { notes: "note" });
        await assignJob();
        assert.equal(await cleared("DOCUMENTS"), false);
    });

    test("VERIFY-RESET-009: the OCR / pipeline marking a document VERIFIED is not a manual verification", async () => {
        await addDocument(P, "PASSPORT", "VERIFIED");
        await addDocument(P, "MEDICAL", "VERIFIED");
        assert.equal(await prisma.candidateVerification.count(), 0);
        assert.equal(await code(), "REGISTERED");
        // A document changing to VERIFIED later does not create one either.
        const waiting = await addDocument(P, "SCAN", "REVIEW_REQUIRED");
        await prisma.document.update({ where: { documentId: waiting.documentId }, data: { verificationStatus: "VERIFIED" } });
        assert.equal(await prisma.candidateVerification.count(), 0);
        assert.equal((await api(USERS.ADMIN, "GET", `/candidates/${P}`)).body.verification.documents, null);
    });

    test("VERIFY-RESET-010: after a reset, ADMIN and MANAGER can verify again; the others still cannot", async () => {
        await verifiedDocuments();
        await addDocument(P, "MEDICAL", "REVIEW_REQUIRED");
        assert.equal(await cleared("DOCUMENTS"), true);
        for (const who of [USERS.ANALYST, USERS.DESK]) assert.equal((await verify(P, "DOCUMENTS", true, who)).status, 403);
        assert.equal((await verify(P, "DOCUMENTS", true, USERS.ADMIN)).status, 200);
        assert.equal(await code(), "DOCUMENTS_VERIFIED");
        assert.equal((await verification()).documentsVerifiedById, USERS.ADMIN.adminId);
        await editDetails({ address: "x" });
        await completeCandidateDetails();
        await addDocument(P, "PASSPORT", "VERIFIED").catch(() => null);
        assert.equal((await audit("VERIFY_DOCUMENTS")).length, 2);
    });

    test("VERIFY-RESET-011: the automatic reset is audited with the actor of the underlying edit, the type and a reason, and no contents", async () => {
        await verifiedDetails();
        await editDetails({ address: "A very private new address" }, USERS.ANALYST).then(() => null);
        // The analyst is not allocated, so that edit was refused; an admin edit is audited.
        assert.equal(await cleared("DETAILS"), false);
        await editDetails({ address: "A very private new address" }, USERS.ADMIN);
        const [entry] = await audit("DETAILS_VERIFICATION_RESET");
        assert.deepEqual([entry.adminId, entry.passportId, entry.previousStatus, entry.newStatus], [USERS.ADMIN.adminId, P, "VERIFIED", "NOT_VERIFIED"]);
        assert.equal(entry.reason, "Candidate details changed after verification");
        assert.ok(entry.createdDate);
        assert.doesNotMatch(JSON.stringify(entry), /private new address/);
        // Documents: the actor of the upload / review.
        await verifiedDocuments();
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT set_config('app.actor_id', ${USERS.MANAGER.adminId}, true)`;
            await tx.document.create({ data: { documentId: "doc-reset-1", passportId: P, documentType: "SCAN", originalFilename: "f.pdf", storedFilename: "f.pdf", storagePath: "p/reset.pdf", receivedDate: new Date(), processingStatus: "PROCESSED", verificationStatus: "VERIFIED" } });
        });
        const [docEntry] = await audit("DOCUMENTS_VERIFICATION_RESET");
        assert.deepEqual([docEntry.adminId, docEntry.reason], [USERS.MANAGER.adminId, "Required document added (SCAN)"]);
        // The audit category lists both new actions.
        const categories = (await api(USERS.ADMIN, "GET", "/audit-logs?category=CANDIDATE")).body;
        assert.ok(categories.items.some((i) => i.action === "DETAILS_VERIFICATION_RESET"));
    });

    test("an automated change (no signed-in user) still resets, without an audit entry; an unknown actor can never block the change", async () => {
        await verifiedDocuments();
        await addDocument(P, "MEDICAL", "VERIFIED");
        assert.equal(await cleared("DOCUMENTS"), true);
        assert.equal((await audit("DOCUMENTS_VERIFICATION_RESET")).length, 0, "no actor, no entry (audit_logs needs a user)");
        await verify(P, "DOCUMENTS");
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT set_config('app.actor_id', 'no-such-user', true)`;
            await tx.document.create({ data: { documentId: "doc-reset-2", passportId: P, documentType: "SCAN", originalFilename: "f.pdf", storedFilename: "f.pdf", storagePath: "p/r2.pdf", receivedDate: new Date(), processingStatus: "PROCESSED", verificationStatus: "VERIFIED" } });
        });
        assert.equal(await cleared("DOCUMENTS"), true, "the document was written and the verification reset");
        assert.equal((await audit("DOCUMENTS_VERIFICATION_RESET")).length, 0);
    });

    test("VERIFY-RESET-012: the reset and the change are one transaction: a rolled-back change leaves the verification alone", async () => {
        await verifiedDocuments();
        await assert.rejects(prisma.$transaction(async (tx) => {
            await tx.document.create({ data: { documentId: "doc-rollback", passportId: P, documentType: "SCAN", originalFilename: "f.pdf", storedFilename: "f.pdf", storagePath: "p/rb.pdf", receivedDate: new Date(), processingStatus: "PROCESSED", verificationStatus: "VERIFIED" } });
            assert.equal(await cleared("DOCUMENTS"), false, "(the reset is not visible outside the transaction yet)");
            throw new Error("fail after the change");
        }));
        assert.equal(await prisma.document.count({ where: { documentId: "doc-rollback" } }), 0);
        assert.equal(await cleared("DOCUMENTS"), false, "the change rolled back, so did the reset");
        assert.equal((await audit("DOCUMENTS_VERIFICATION_RESET")).length, 0);
        // And the details edit through the service: an invalid edit changes nothing and keeps the verification.
        await completeCandidateDetails();
        await addDocument(P, "PASSPORT", "REVIEW_REQUIRED").catch(() => null);
        await verify(P, "DETAILS");
        const refused = await editDetails({ nic: "" });
        assert.ok(refused.status >= 400);
        assert.equal(await cleared("DETAILS"), false);
    });

    test("VERIFY-RESET-013 / 014: Document submission complete is Visa Document Ready; FAIL still overrides everything, resets included", async () => {
        await verifiedDetails();
        await verify(P, "DOCUMENTS");
        await completeDocumentSubmission();
        assert.equal(await cleared("DOCUMENTS"), true, "four new required documents reset the sign-off");
        assert.equal(await code(), "VISA_DOCUMENT_READY");
        await setResult(P, "FAIL");
        assert.equal(await code(), "STOPPED_WITH_TEST");
        await editDetails({ address: "While stopped" });
        assert.equal(await code(), "STOPPED_WITH_TEST", "a reset while stopped does not change the override");
        await setResult(P, "PASS");
        assert.equal(await code(), "VISA_DOCUMENT_READY", "the latest currently valid status returns");
    });

    test("the migration is additive: only functions and triggers; existing verification rows are not touched", async () => {
        const triggers = (await pg.query(`SELECT tgname FROM pg_trigger WHERE tgname LIKE '%changed_reset%' AND NOT tgisinternal ORDER BY 1`)).rows.map((r) => r.tgname);
        assert.deepEqual(triggers, ["candidate_additional_details_changed_reset_ins_trg", "candidate_additional_details_changed_reset_upd_trg", "candidate_details_changed_reset_trg", "documents_changed_reset_ins_del_trg", "documents_changed_reset_upd_trg"]);
    });
});

describe("the list itself (STATUS-018) and RBAC", () => {
    test("STATUS-018: search and paging are unchanged, and every row carries a Status plus the stages it always had", async () => {
        const all = await api(USERS.ADMIN, "GET", "/candidates");
        assert.deepEqual(all.body.items.map((i) => i.passportId).sort(), [P, Q]);
        assert.equal(all.body.pagination.total, 2);
        assert.ok(all.body.items.every((item) => item.workflowStatus.label && item.stages.length === 8));
        const searched = await api(USERS.ADMIN, "GET", "/candidates?search=Perera");
        assert.deepEqual(searched.body.items.map((i) => i.passportId), [P]);
        const page2 = await api(USERS.ADMIN, "GET", "/candidates?pageSize=1&page=2");
        assert.equal(page2.body.items.length, 1);
        assert.equal(page2.body.pagination.totalPages, 2);
        assert.deepEqual(page2.body.filters, { search: null }, "no Status filter was added");
    });

    test("every Candidates role sees the Status; an Analyst only for their own candidates", async () => {
        await prisma.candidateAllocation.create({ data: { passportId: P, analystId: USERS.ANALYST.adminId } });
        for (const who of [USERS.ADMIN, USERS.MANAGER, USERS.DESK]) assert.equal((await statusOf(P, who)).code, "REGISTERED", who.role);
        const own = await api(USERS.ANALYST, "GET", "/candidates");
        assert.deepEqual(own.body.items.map((i) => [i.passportId, i.workflowStatus.code]), [[P, "REGISTERED"]]);
    });

    test("Status is derived only: the stage API takes no status, and nothing is stored for it", async () => {
        const refused = await api(USERS.ADMIN, "PUT", `/candidates/${P}/stages/TEST_DETAILS`, { workflowStatus: "VISA_DOCUMENT_READY", testResult: "PASS" });
        assert.equal(await code(), "REGISTERED");
        assert.ok([200, 400].includes(refused.status));
        const columns = (await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('candidate','candidate_stages') AND column_name ILIKE '%status%'`)).rows;
        assert.deepEqual(columns, [], "no status column exists on candidate or candidate_stages");
    });
});
