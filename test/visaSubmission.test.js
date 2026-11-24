// Visa Submission Phase 1: the slot config, the manifest, the slot document stream, the merged
// download audit, and the VISA_SUBMISSION document's upload (PDF only, VISA_SUBMISSION_ROLES only,
// completing the stage when the visa rules pass) and removal (reopening it). On a REAL PostgreSQL
// (PGlite, every migration applied) through the real Prisma client and the real admin router; the
// storage bucket is an in-memory fake that streams like Supabase's download().asStream().
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { giveTestPassAndJob } from "./helpers/visaPrerequisites.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ALL_ROLES, hasRole } from "../src/middleware/requireRole.js";
import { VISA_SUBMISSION_ROLES, VISA_SUBMISSION_SLOTS, VISA_SUBMISSION_SLOT_KEYS } from "../src/config/visaSubmission.js";
import { getVisaSubmissionFile } from "../src/services/visaSubmissionService.js";
import { categoryOf } from "../src/services/auditLogService.js";

const user = (role, n) => ({ adminId: `vs-${role.toLowerCase()}`, role, name: `${role} user`, email: `vs.${role.toLowerCase()}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n + 700).padStart(12, "0")}`, status: "ACTIVE" });
const USERS = Object.fromEntries(ALL_ROLES.map((role, n) => [role, user(role, n + 1)]));
const CAND = "VS0000001";    // allocated to the ANALYST
const OTHER = "VS0000002";
const NO_ID = "11111111-1111-4111-8111-111111111111";
const pdf = (tag) => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from(String(tag)), Buffer.alloc(64, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

// Supabase Storage as candidateService.js and visaSubmissionService.js use it. download() returns a
// builder like Supabase's: awaited, the whole body (a Buffer here); asStream(), a web ReadableStream.
function createBucket() {
    const objects = new Map();
    const meta = new Map();
    const signedUploads = [];
    const reads = { stream: 0, whole: 0 };
    const notFound = () => ({ statusCode: "404", message: "Object not found" });
    const store = (path, buffer, contentType) => { objects.set(path, buffer); meta.set(path, { contentType, createdAt: new Date() }); };
    const bucket = {
        objects, signedUploads, reads, failDownload: false, hangDownload: false,
        store,
        upload: async (path, buffer, { contentType } = {}) => {
            if (objects.has(path)) return { error: { statusCode: "409", message: "The resource already exists" } };
            store(path, buffer, contentType);
            return { error: null };
        },
        remove: async (paths) => { paths.forEach((p) => { objects.delete(p); meta.delete(p); }); return { error: null }; },
        createSignedUploadUrl: async (path) => {
            signedUploads.push(path);
            return { data: { signedUrl: `https://storage.example.invalid/upload/${signedUploads.length}`, path }, error: null };
        },
        browserPut: (path, buffer, contentType) => {
            if (!signedUploads.includes(path)) throw new Error("no signed upload URL for this path");
            store(path, buffer, contentType);
        },
        info: async (path) => (objects.has(path) ? { data: { size: objects.get(path).length, contentType: meta.get(path).contentType }, error: null } : { data: null, error: notFound() }),
        exists: async (path) => (objects.has(path) ? { data: true, error: null } : { data: false, error: notFound() }),
        move: async (from, to) => {
            if (!objects.has(from)) return { data: null, error: notFound() };
            if (objects.has(to)) return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
            store(to, objects.get(from), meta.get(from).contentType);
            objects.delete(from);
            meta.delete(from);
            return { data: {}, error: null };
        },
        list: async () => ({ data: [], error: null }),
        download: (path) => {
            const answer = (body) => {
                if (bucket.failDownload) return { data: null, error: { statusCode: "500", message: "storage unavailable" } };
                return objects.has(path) ? { data: body(objects.get(path)), error: null } : { data: null, error: notFound() };
            };
            return {
                then: (resolve, reject) => { reads.whole += 1; return Promise.resolve(answer((bytes) => bytes)).then(resolve, reject); },
                asStream: () => {
                    reads.stream += 1;
                    if (bucket.hangDownload) return new Promise(() => {});
                    return Promise.resolve(answer((bytes) => new Blob([bytes]).stream()));
                },
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

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
    const app = express();
    app.use(express.json());
    // The caller is chosen per request, and its role read from the database (like requireActiveUser).
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: req.get("x-test-user") }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        if (!req.user) return res.status(401).json({ message: "Invalid or Expired Token" });
        return next();
    };
    // The bucket is replaced per test: the router reads it through this getter-backed proxy.
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
        DELETE FROM "rate_limits"; DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "documents"; DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    bucket = createBucket();
    for (const [passportId, uniqueId, nic] of [[CAND, "9301", "199112345678"], [OTHER, "9302", "199112345679"]]) {
        await prisma.candidate.create({ data: { passportId, uniqueId, firstName: "Nimal", otherName: "Perera", nic } });
    }
    await prisma.candidateAllocation.create({ data: { passportId: CAND, analystId: USERS.ANALYST.adminId } });
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

// A stored document row and its object in the bucket. `minutesAgo` orders the received dates.
async function seed(passportId, documentType, { variant = null, status = "VERIFIED", mimeType = "application/pdf", minutesAgo = 10 } = {}) {
    sequence += 1;
    const bytes = mimeType === "application/pdf" ? pdf(`doc-${sequence}`) : PNG;
    const documentId = crypto.randomUUID();
    const storedFilename = `${documentType.toLowerCase()}_v${sequence}.${mimeType === "application/pdf" ? "pdf" : "png"}`;
    const storagePath = `clients/${passportId}/${documentType.toLowerCase()}/${storedFilename}`;
    bucket.store(storagePath, bytes, mimeType);
    await prisma.document.create({
        data: {
            documentId, passportId, documentType, originalFilename: storedFilename, storedFilename, storagePath, mimeType,
            fileSize: BigInt(bytes.length), receivedDate: new Date(Date.now() - minutesAgo * 60_000), processingStatus: "STORED",
            verificationStatus: status, fileSha256: crypto.createHash("sha256").update(bytes).digest("hex"), documentVariant: variant,
        },
    });
    return { documentId, bytes };
}

// The browser's upload: target, PUT to storage, finalize. Returns the finalize answer (or the target's when refused).
async function upload(who, passportId, { type = "VISA_SUBMISSION", variant, mimeType = "application/pdf", buffer = pdf(`upload-${++sequence}`), declared = mimeType } = {}) {
    const described = { type, ...(variant ? { variant } : {}), mimeType: declared, fileName: "file.pdf" };
    const target = await api(who, "POST", `/candidates/${passportId}/documents/upload-target`, { ...described, fileSize: buffer.length });
    if (target.status !== 200) return target;
    bucket.browserPut(bucket.signedUploads.at(-1), buffer, mimeType);
    return api(who, "POST", `/candidates/${passportId}/documents/finalize`, { ...described, uploadId: target.body.uploadId });
}
const visaStage = async (passportId = CAND) => prisma.candidateStage.findUnique({ where: { passportId_stage: { passportId, stage: "VISA_SUBMISSION" } } });

describe("config", () => {
    test("six slots in the merge order, stable keys and labels; the police slip is not one", () => {
        assert.deepEqual(VISA_SUBMISSION_SLOTS.map((s) => [s.order, s.key, s.label, s.documentType, s.variant]), [
            [1, "PASSPORT", "Passport", "PASSPORT", null],
            [2, "SL_NORMAL_POLICE_REPORT", "SL Normal Police Report", "POLICE_REPORT", "SL_NORMAL"],
            [3, "SL_VERIFIED_POLICE_REPORT", "SL Verified Police Report", "POLICE_REPORT", "SL_VERIFIED"],
            [4, "ROMANIA_POLICE_REPORT", "Romania Police Report", "POLICE_REPORT", "ROMANIA"],
            [5, "MEDICAL", "Medical", "MEDICAL", null],
            [6, "SCAN", "Scan", "SCAN", null],
        ]);
        assert.ok(!VISA_SUBMISSION_SLOTS.some((s) => s.documentType === "POLICE_SLIP"));
        assert.ok(Object.isFrozen(VISA_SUBMISSION_SLOTS) && Object.isFrozen(VISA_SUBMISSION_SLOTS[0]));
    });

    test("VISA_SUBMISSION_ROLES: ADMIN and TEAM_LEAD; OWNER through hasRole; no other role", () => {
        assert.deepEqual(VISA_SUBMISSION_ROLES, ["ADMIN", "TEAM_LEAD"]);
        assert.deepEqual(ALL_ROLES.filter((role) => hasRole(role, VISA_SUBMISSION_ROLES)), ["OWNER", "ADMIN", "TEAM_LEAD"]);
    });
});

describe("manifest", () => {
    test("each slot in order: VERIFIED (current document), UNVERIFIED, MISSING; superseded and other types ignored", async () => {
        await seed(CAND, "PASSPORT", { status: "SUPERSEDED", minutesAgo: 30 });
        const passport = await seed(CAND, "PASSPORT", { minutesAgo: 20 });
        await seed(CAND, "PASSPORT", { status: "SUPERSEDED", minutesAgo: 1 });     // newer, but superseded
        await seed(CAND, "POLICE_REPORT", { variant: "SL_NORMAL", status: "REVIEW_REQUIRED" });
        const slVerified = await seed(CAND, "POLICE_REPORT", { variant: "SL_VERIFIED" });
        await seed(CAND, "POLICE_REPORT", { variant: "ROMANIA", status: "SUPERSEDED" });
        await seed(CAND, "POLICE_REPORT");                                          // no variant: fills no slot
        await seed(CAND, "POLICE_SLIP");
        await seed(CAND, "VISA_SUBMISSION");
        const scan = await seed(CAND, "SCAN", { mimeType: "image/png" });
        await seed(OTHER, "MEDICAL");                                               // another candidate's

        for (const who of [USERS.ADMIN, USERS.OWNER, USERS.TEAM_LEAD]) {
            const manifest = ok(await api(who, "GET", `/candidates/${CAND}/visa-submission/manifest`));
            assert.equal(manifest.passportId, CAND);
            assert.deepEqual(manifest.slots.map((s) => [s.order, s.key, s.status]), [
                [1, "PASSPORT", "VERIFIED"], [2, "SL_NORMAL_POLICE_REPORT", "UNVERIFIED"], [3, "SL_VERIFIED_POLICE_REPORT", "VERIFIED"],
                [4, "ROMANIA_POLICE_REPORT", "MISSING"], [5, "MEDICAL", "MISSING"], [6, "SCAN", "VERIFIED"],
            ], who.role);
            const [first, second] = manifest.slots;
            assert.deepEqual(first, {
                order: 1, key: "PASSPORT", label: "Passport", documentType: "PASSPORT", variant: null, status: "VERIFIED",
                document: { documentId: passport.documentId, mimeType: "application/pdf", size: passport.bytes.length, fileUrl: `/api/admin/candidates/${CAND}/visa-submission/files/${passport.documentId}` },
            });
            assert.equal(second.document, null, "an unverified slot names no document");
            assert.equal(manifest.slots[2].document.documentId, slVerified.documentId);
            assert.deepEqual([manifest.slots[5].document.documentId, manifest.slots[5].document.mimeType], [scan.documentId, "image/png"]);
            assert.doesNotMatch(JSON.stringify(manifest), /storage|clients\//, "no storage path");
        }
    });

    test("ANALYST, REGISTRATION_DESK and JOB_HANDLER are refused; an unknown candidate is 404", async () => {
        for (const role of ["ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]) {
            const response = await api(USERS[role], "GET", `/candidates/${CAND}/visa-submission/manifest`);
            assert.deepEqual([response.status, response.body], [403, { message: "Insufficient permissions" }], role);
        }
        assert.equal((await api(USERS.ADMIN, "GET", "/candidates/VS9999999/visa-submission/manifest")).status, 404);
        assert.equal((await api(USERS.ADMIN, "GET", "/candidates/bad!id/visa-submission/manifest")).status, 400);
    });
});

describe("slot document stream", () => {
    const file = (who, documentId, passportId = CAND) => api(who, "GET", `/candidates/${passportId}/visa-submission/files/${documentId}`);

    test("ADMIN, OWNER and TEAM_LEAD get the bytes, streamed, with the review file's safe headers", async () => {
        const medical = await seed(CAND, "MEDICAL");
        for (const who of [USERS.ADMIN, USERS.OWNER, USERS.TEAM_LEAD]) {
            const response = await file(who, medical.documentId);
            assert.equal(response.status, 200, who.role);
            assert.ok(response.bytes.equals(medical.bytes), who.role);
            assert.equal(response.headers.get("content-type"), "application/pdf");
            assert.equal(response.headers.get("content-length"), String(medical.bytes.length));
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.match(response.headers.get("content-security-policy"), /sandbox/);
            assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
            assert.match(response.headers.get("content-disposition"), /^inline; filename="medical_v\d+\.pdf"$/);
        }
        assert.deepEqual(bucket.reads, { stream: 3, whole: 0 }, "read as a stream, never as a whole body");
    });

    test("ANALYST and REGISTRATION_DESK (and JOB_HANDLER) are refused before anything is read", async () => {
        const medical = await seed(CAND, "MEDICAL");
        for (const role of ["ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]) assert.equal((await file(USERS[role], medical.documentId)).status, 403, role);
        assert.deepEqual(bucket.reads, { stream: 0, whole: 0 });
    });

    test("only the URL candidate's current VERIFIED slot document: everything else is 404 and nothing is read", async () => {
        const others = await seed(OTHER, "MEDICAL");
        const slip = await seed(CAND, "POLICE_SLIP");
        const visa = await seed(CAND, "VISA_SUBMISSION");
        const untyped = await seed(CAND, "POLICE_REPORT");
        const waiting = await seed(CAND, "SCAN", { status: "REVIEW_REQUIRED" });
        const superseded = await seed(CAND, "PASSPORT", { status: "SUPERSEDED" });
        for (const [label, documentId] of [["another candidate's", others.documentId], ["police slip", slip.documentId], ["visa submission", visa.documentId],
            ["police report without variant", untyped.documentId], ["not verified", waiting.documentId], ["superseded", superseded.documentId], ["no such document", NO_ID]]) {
            const response = await file(USERS.ADMIN, documentId);
            assert.deepEqual([response.status, response.body?.code], [404, "DOCUMENT_NOT_FOUND"], label);
        }
        assert.equal((await file(USERS.ADMIN, others.documentId, OTHER)).status, 200, "on its own candidate's URL it is served");
        assert.equal((await file(USERS.ADMIN, "not-an-id")).status, 400);
        assert.equal((await file(USERS.ADMIN, others.documentId, "VS9999999")).status, 404);
    });

    test("storage failure is 502; a storage call that does not answer is given up on (timeout)", async () => {
        const medical = await seed(CAND, "MEDICAL");
        bucket.failDownload = true;
        const failed = await file(USERS.ADMIN, medical.documentId);
        assert.deepEqual([failed.status, failed.body], [502, { message: "The file could not be loaded from storage" }]);
        bucket.failDownload = false;
        bucket.hangDownload = true;
        const result = await getVisaSubmissionFile({ db: prisma, bucket, passportId: CAND, documentId: medical.documentId, timeoutMs: 20 });
        assert.deepEqual(result, { unavailable: true });
    });
});

describe("merged download audit", () => {
    const record = (who, body, passportId = CAND) => api(who, "POST", `/candidates/${passportId}/visa-submission/merged-download`, body);

    test("one VISA_SUBMISSION_MERGED_DOWNLOAD entry: the actor, the candidate, the slots included (with their documents) and excluded", async () => {
        const passport = await seed(CAND, "PASSPORT");
        const scan = await seed(CAND, "SCAN");
        const answer = ok(await record(USERS.TEAM_LEAD, { includedSlots: ["SCAN", "PASSPORT"], somethingElse: "ignored" }), 201);
        assert.deepEqual(answer.includedSlots, ["PASSPORT", "SCAN"], "in the merge order");
        assert.deepEqual(answer.excludedSlots, ["SL_NORMAL_POLICE_REPORT", "SL_VERIFIED_POLICE_REPORT", "ROMANIA_POLICE_REPORT", "MEDICAL"]);

        const rows = await prisma.auditLog.findMany({ where: { action: "VISA_SUBMISSION_MERGED_DOWNLOAD" } });
        assert.equal(rows.length, 1);
        const [row] = rows;
        assert.deepEqual([row.auditId, row.adminId, row.passportId, row.previousStatus, row.newStatus], [answer.auditId, USERS.TEAM_LEAD.adminId, CAND, "NONE", "DOWNLOADED"]);
        assert.deepEqual(JSON.parse(row.newValue), {
            includedSlots: ["PASSPORT", "SCAN"],
            excludedSlots: ["SL_NORMAL_POLICE_REPORT", "SL_VERIFIED_POLICE_REPORT", "ROMANIA_POLICE_REPORT", "MEDICAL"],
            documents: { PASSPORT: passport.documentId, SCAN: scan.documentId },
        });
        assert.doesNotMatch(row.newValue, /ignored/);
        assert.equal(categoryOf("VISA_SUBMISSION_MERGED_DOWNLOAD"), "DOCUMENT");

        // In Audit Logs under its category.
        const logs = ok(await api(USERS.ADMIN, "GET", "/audit-logs?category=DOCUMENT&action=VISA_SUBMISSION_MERGED_DOWNLOAD"));
        assert.deepEqual(logs.items.map((i) => [i.action, i.category, i.candidate.passportId]), [["VISA_SUBMISSION_MERGED_DOWNLOAD", "DOCUMENT", CAND]]);
    });

    test("the body is validated; a slot that is not VERIFIED is refused; other roles are refused; nothing is written", async () => {
        await seed(CAND, "PASSPORT");
        await seed(CAND, "MEDICAL", { status: "REVIEW_REQUIRED" });
        for (const body of [{}, { includedSlots: [] }, { includedSlots: "PASSPORT" }, { includedSlots: ["PASSPORT", "PASSPORT"] }, { includedSlots: ["POLICE_SLIP"] }, { includedSlots: [1] }, [], { includedSlots: [...VISA_SUBMISSION_SLOT_KEYS, "X"] }]) {
            assert.equal((await record(USERS.ADMIN, body)).status, 400, JSON.stringify(body));
        }
        const unverified = await record(USERS.ADMIN, { includedSlots: ["PASSPORT", "MEDICAL"] });
        assert.deepEqual([unverified.status, unverified.body.code], [409, "SLOT_NOT_VERIFIED"]);
        assert.deepEqual([(await record(USERS.ADMIN, { includedSlots: ["SCAN"] })).status], [409], "missing");
        for (const role of ["ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]) assert.equal((await record(USERS[role], { includedSlots: ["PASSPORT"] })).status, 403, role);
        assert.equal((await record(USERS.ADMIN, { includedSlots: ["PASSPORT"] }, "VS9999999")).status, 404);
        assert.equal(await prisma.auditLog.count({ where: { action: "VISA_SUBMISSION_MERGED_DOWNLOAD" } }), 0);
        assert.equal(ok(await record(USERS.OWNER, { includedSlots: ["PASSPORT"] }), 201).includedSlots.length, 1, "OWNER");
    });
});

describe("the VISA_SUBMISSION document: upload and removal", () => {
    test("PDF only: another type is refused before a URL is issued; image bytes declared as a PDF are refused at finalize", async () => {
        for (const mimeType of ["image/png", "image/jpeg", "video/mp4"]) {
            const refused = await api(USERS.ADMIN, "POST", `/candidates/${CAND}/documents/upload-target`, { type: "VISA_SUBMISSION", mimeType, fileSize: 100 });
            assert.deepEqual([refused.status, refused.body.code, refused.body.message], [422, "FILE_REJECTED", "This file type is not accepted. Use PDF."], mimeType);
        }
        assert.equal(bucket.signedUploads.length, 0);
        const disguised = await upload(USERS.ADMIN, CAND, { buffer: PNG });
        assert.deepEqual([disguised.status, disguised.body.code], [422, "FILE_REJECTED"]);
        assert.equal(await prisma.document.count(), 0);
        assert.equal(bucket.objects.size, 0, "the staged file is removed");
    });

    test("ANALYST (even for an allocated candidate), REGISTRATION_DESK and JOB_HANDLER can't upload or finalize", async () => {
        for (const role of ["ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]) {
            assert.equal((await upload(USERS[role], CAND)).status, 403, role);
            const finalize = await api(USERS[role], "POST", `/candidates/${CAND}/documents/finalize`, { type: "VISA_SUBMISSION", mimeType: "application/pdf", uploadId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" });
            assert.equal(finalize.status, 403, role);
        }
        const analyst = await upload(USERS.ANALYST, CAND);
        assert.deepEqual(analyst.body, { message: "Insufficient permissions", code: "VISA_SUBMISSION_FORBIDDEN" });
        assert.equal(bucket.signedUploads.length, 0);
        assert.equal(await prisma.document.count(), 0);
    });

    test("rules fail: the document is stored, the stage stays open, and the finalize answer says why", async () => {
        const noTest = await upload(USERS.TEAM_LEAD, CAND);
        assert.equal(noTest.status, 200);
        assert.deepEqual(noTest.body.stageCompletion, { stage: "VISA_SUBMISSION", completed: false, code: "VISA_NEEDS_TEST_PASS", reason: "The candidate must pass the test before the visa stage can be completed." });
        assert.equal(noTest.body.documents.VISA_SUBMISSION.verificationStatus, "VERIFIED");
        assert.equal(noTest.body.stages.find((s) => s.stage === "VISA_SUBMISSION").completed, false);

        await prisma.candidateStage.create({ data: { passportId: CAND, stage: "TEST_DETAILS", testResult: "PASS" } });
        const noJob = await upload(USERS.ADMIN, CAND);
        assert.deepEqual(noJob.body.stageCompletion, { stage: "VISA_SUBMISSION", completed: false, code: "VISA_NEEDS_JOB", reason: "Assign the candidate to a Job before completing the visa stage." });
        assert.equal((await visaStage())?.completed ?? false, false);
        assert.equal(await prisma.auditLog.count({ where: { action: "UPDATE_STAGE" } }), 0);
        assert.equal(await prisma.document.count({ where: { documentType: "VISA_SUBMISSION" } }), 2);
    });

    test("rules pass: the stage is completed in the same save (audited); removing the document reopens it (audited)", async () => {
        await giveTestPassAndJob(prisma, CAND, USERS.ADMIN.adminId);
        const before = Date.now();
        const done = await upload(USERS.OWNER, CAND);
        assert.equal(done.status, 200, JSON.stringify(done.body));
        assert.deepEqual(done.body.stageCompletion, { stage: "VISA_SUBMISSION", completed: true, code: null, reason: null });
        assert.equal(done.body.stages.find((s) => s.stage === "VISA_SUBMISSION").completed, true);
        const stage = await visaStage();
        assert.equal(stage.completed, true);
        assert.ok(stage.completedAt.getTime() >= before - 1000);
        const completedAudit = await prisma.auditLog.findMany({ where: { action: "UPDATE_STAGE", passportId: CAND } });
        assert.deepEqual(completedAudit.map((a) => [a.adminId, a.previousStatus, a.newStatus, JSON.parse(a.newValue)]), [[USERS.OWNER.adminId, "NOT_COMPLETED", "COMPLETED", { stage: "VISA_SUBMISSION", completed: true }]]);

        // A second upload while completed: stays completed, no second stage entry.
        const again = await upload(USERS.TEAM_LEAD, CAND);
        assert.equal(again.body.stageCompletion.completed, true);
        assert.equal(await prisma.auditLog.count({ where: { action: "UPDATE_STAGE" } }), 1);

        const { documentId } = again.body.documents.VISA_SUBMISSION;
        const removePath = `/candidates/${CAND}/documents/${documentId}/remove`;
        const analyst = await api(USERS.ANALYST, "POST", removePath, { reason: "Wrong file" });
        assert.deepEqual([analyst.status, analyst.body.code], [403, "VISA_SUBMISSION_FORBIDDEN"]);
        assert.equal((await visaStage()).completed, true, "the Analyst's refused removal changes nothing");
        assert.equal(await prisma.document.count({ where: { documentId } }), 1);

        const removed = ok(await api(USERS.TEAM_LEAD, "POST", removePath, { reason: "Wrong embassy form" }));
        assert.equal(removed.documents.VISA_SUBMISSION, null);
        assert.equal(removed.stages.find((s) => s.stage === "VISA_SUBMISSION").completed, false);
        const reopened = await visaStage();
        assert.deepEqual([reopened.completed, reopened.completedAt], [false, null]);
        const audits = await prisma.auditLog.findMany({ where: { action: { in: ["UPDATE_STAGE", "REMOVE_DOCUMENT"] } }, orderBy: { createdDate: "asc" } });
        assert.deepEqual(audits.slice(1).map((a) => [a.action, a.previousStatus, a.newStatus]).sort(), [["REMOVE_DOCUMENT", "VERIFIED", "REMOVED"], ["UPDATE_STAGE", "COMPLETED", "NOT_COMPLETED"]]);
    });

    test("the manual completion form still works as before (an allocated ANALYST may complete the stage)", async () => {
        await giveTestPassAndJob(prisma, CAND, USERS.ADMIN.adminId);
        const saved = ok(await api(USERS.ANALYST, "PUT", `/candidates/${CAND}/stages/VISA_SUBMISSION`, { completed: true, notes: "Submitted at the embassy" }));
        assert.equal(saved.stages.find((s) => s.stage === "VISA_SUBMISSION").completed, true);
        assert.equal(saved.stageCompletion, undefined);
        const refused = await api(USERS.ADMIN, "PUT", `/candidates/${OTHER}/stages/VISA_SUBMISSION`, { completed: true });
        assert.deepEqual([refused.status, refused.body.code], [409, "VISA_NEEDS_TEST_PASS"]);
    });
});

describe("regression: the other document types keep their permissions and rules", () => {
    test("an allocated ANALYST uploads, finalizes and removes a medical (PNG accepted); no stageCompletion", async () => {
        const done = await upload(USERS.ANALYST, CAND, { type: "MEDICAL", mimeType: "image/png", buffer: PNG });
        assert.equal(done.status, 200, JSON.stringify(done.body));
        assert.equal(done.body.stageCompletion, undefined);
        const { documentId } = done.body.documents.MEDICAL;
        const removed = ok(await api(USERS.ANALYST, "POST", `/candidates/${CAND}/documents/${documentId}/remove`, { reason: "Blurred" }));
        assert.equal(removed.documents.MEDICAL, null);
        assert.equal(await visaStage(), null, "no visa stage row is touched");
    });

    test("an ANALYST still can't reach a candidate not allocated to them (404); REGISTRATION_DESK still uploads the passport only", async () => {
        assert.equal((await upload(USERS.ANALYST, OTHER, { type: "MEDICAL" })).status, 404);
        assert.equal((await upload(USERS.REGISTRATION_DESK, CAND, { type: "PASSPORT" })).status, 200);
        assert.equal((await upload(USERS.REGISTRATION_DESK, CAND, { type: "MEDICAL" })).status, 403);
        assert.equal((await upload(USERS.JOB_HANDLER, CAND, { type: "MEDICAL" })).status, 403);
        for (const who of [USERS.TEAM_LEAD, USERS.ADMIN, USERS.OWNER]) {
            assert.equal((await upload(who, CAND, { type: "POLICE_REPORT", variant: "ROMANIA" })).status, 200, who.role);
        }
    });
});
