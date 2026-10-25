import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
    listCandidates,
    fetchConsolidatedCandidateRelations,
    fetchFallbackCandidateRelations,
    REQUIRED_SUBMISSION_DOCUMENTS,
} from "../src/services/candidateService.js";

const ADMIN = {
    adminId: "user-admin",
    authUserId: "00000000-0000-4000-8000-000000000001",
    name: "Ada Admin",
    email: "ada@example.invalid",
    role: "ADMIN",
    status: "ACTIVE",
};

let database;
let prisma;
let pg;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    await prisma.user.create({ data: ADMIN });

    // Seed diverse candidates:
    // P0000001: No relations
    // P0000002: Multiple stages
    // P0000003: Multiple documents (required + non-required)
    // P0000004: Multiple job assignments (active + inactive)
    // P0000005: Verification present (both verified)
    // P0000006: Partial verification (details verified only)
    // P0000007: Verification row with null timestamps
    // P0000008: Without verification row

    const candidates = [
        { passportId: "P0000001", uniqueId: "1001", firstName: "Alice", otherName: "One", createdDate: new Date("2026-01-01T10:00:00Z") },
        { passportId: "P0000002", uniqueId: "1002", firstName: "Bob", otherName: "Two", createdDate: new Date("2026-01-01T11:00:00Z") },
        { passportId: "P0000003", uniqueId: "1003", firstName: "Charlie", otherName: "Three", createdDate: new Date("2026-01-01T12:00:00Z") },
        { passportId: "P0000004", uniqueId: "1004", firstName: "David", otherName: "Four", createdDate: new Date("2026-01-01T13:00:00Z") },
        { passportId: "P0000005", uniqueId: "1005", firstName: "Eve", otherName: "Five", createdDate: new Date("2026-01-01T14:00:00Z") },
        { passportId: "P0000006", uniqueId: "1006", firstName: "Frank", otherName: "Six", createdDate: new Date("2026-01-01T15:00:00Z") },
        { passportId: "P0000007", uniqueId: "1007", firstName: "Grace", otherName: "Seven", createdDate: new Date("2026-01-01T16:00:00Z") },
        { passportId: "P0000008", uniqueId: "1008", firstName: "Heidi", otherName: "Eight", createdDate: new Date("2026-01-01T17:00:00Z") },
    ];

    for (const c of candidates) {
        await prisma.candidate.create({ data: c });
    }

    // P0000002 stages
    await prisma.candidateStage.createMany({
        data: [
            { passportId: "P0000002", stage: "TEST_DETAILS", completed: true, testResult: "PASS" },
            { passportId: "P0000002", stage: "JOB_DETAILS", completed: false, testResult: null },
            { passportId: "P0000002", stage: "IVS_INTERVIEW", completed: true, testResult: null },
        ],
    });

    // P0000003 documents
    await prisma.document.createMany({
        data: [
            { documentId: "doc-1", passportId: "P0000003", documentType: "PASSPORT", documentVariant: null, verificationStatus: "VERIFIED", processingStatus: "PROCESSED", originalFilename: "pass.pdf", storedFilename: "pass.pdf", storagePath: "clients/P0000003/PASSPORT/doc1.pdf", receivedDate: new Date() },
            { documentId: "doc-2", passportId: "P0000003", documentType: "MEDICAL", documentVariant: null, verificationStatus: "VERIFIED", processingStatus: "PROCESSED", originalFilename: "med.pdf", storedFilename: "med.pdf", storagePath: "clients/P0000003/MEDICAL/doc2.pdf", receivedDate: new Date() },
            { documentId: "doc-3", passportId: "P0000003", documentType: "POLICE_REPORT", documentVariant: "SL_VERIFIED", verificationStatus: "VERIFIED", processingStatus: "PROCESSED", originalFilename: "police.pdf", storedFilename: "police.pdf", storagePath: "clients/P0000003/POLICE_REPORT/doc3.pdf", receivedDate: new Date() },
            // Non-required document type - must NOT be included in candidate documents relation
            { documentId: "doc-4", passportId: "P0000003", documentType: "OTHER", documentVariant: null, verificationStatus: "VERIFIED", processingStatus: "PROCESSED", originalFilename: "other.pdf", storedFilename: "other.pdf", storagePath: "clients/P0000003/OTHER/doc4.pdf", receivedDate: new Date() },
        ],
    });

    // Jobs for P0000004
    const jobType = await prisma.jobType.create({ data: { code: "WELDER_CR", name: "Welder CR" } });
    const agent = await prisma.agent.create({ data: { name: "Agent CR", countryCode: "RO" } });
    const client = await prisma.client.create({ data: { name: "Client CR", agentLinks: { create: { agentId: agent.id } } } });
    const job1 = await prisma.job.create({ data: { jobCode: "JOB-2026-000001", jobTypeId: jobType.id, clientId: client.id, responsibleAgentId: agent.id, countryCode: "RO", status: "PROCESSING", createdById: ADMIN.adminId, vacancies: 5 } });
    const job2 = await prisma.job.create({ data: { jobCode: "JOB-2026-000002", jobTypeId: jobType.id, clientId: client.id, responsibleAgentId: agent.id, countryCode: "RO", status: "PROCESSING", createdById: ADMIN.adminId, vacancies: 5 } });
    const job3 = await prisma.job.create({ data: { jobCode: "JOB-2026-000003", jobTypeId: jobType.id, clientId: client.id, responsibleAgentId: agent.id, countryCode: "RO", status: "PROCESSING", createdById: ADMIN.adminId, vacancies: 5 } });

    await prisma.jobCandidate.createMany({
        data: [
            { passportId: "P0000004", jobId: job1.id, isActive: true, assignedBy: ADMIN.adminId },
            { passportId: "P0000004", jobId: job2.id, isActive: false, assignedBy: ADMIN.adminId, releasedAt: new Date() },
            { passportId: "P0000004", jobId: job3.id, isActive: false, assignedBy: ADMIN.adminId, releasedAt: new Date() },
        ],
    });

    // Verification for P0000005, P0000006, P0000007
    await prisma.candidateVerification.create({
        data: {
            passportId: "P0000005",
            detailsVerifiedAt: new Date("2026-01-02T10:00:00Z"),
            detailsVerifiedById: ADMIN.adminId,
            documentsVerifiedAt: new Date("2026-01-02T11:00:00Z"),
            documentsVerifiedById: ADMIN.adminId,
        },
    });
    await prisma.candidateVerification.create({
        data: {
            passportId: "P0000006",
            detailsVerifiedAt: new Date("2026-01-02T12:00:00Z"),
            detailsVerifiedById: ADMIN.adminId,
            documentsVerifiedAt: null,
            documentsVerifiedById: null,
        },
    });
    await prisma.candidateVerification.create({
        data: {
            passportId: "P0000007",
            detailsVerifiedAt: null,
            detailsVerifiedById: null,
            documentsVerifiedAt: null,
            documentsVerifiedById: null,
        },
    });
});

after(async () => database?.close());

describe("Candidate Consolidated Relations - Regression and Compatibility", () => {
    test("fetchConsolidatedCandidateRelations returns one row per passport with expected sub-collections", async () => {
        const passportIds = [
            "P0000001", "P0000002", "P0000003", "P0000004",
            "P0000005", "P0000006", "P0000007", "P0000008",
        ];

        const rows = await fetchConsolidatedCandidateRelations(prisma, passportIds);
        assert.equal(rows.length, passportIds.length);

        const byId = new Map(rows.map((r) => [r.passportId, r]));

        // P0000001: no relations
        const c1 = byId.get("P0000001");
        assert.deepEqual(c1.stages, []);
        assert.deepEqual(c1.documents, []);
        assert.deepEqual(c1.jobAssignments, []);
        assert.equal(c1.verification, null);

        // P0000002: multiple stages
        const c2 = byId.get("P0000002");
        assert.equal(c2.stages.length, 3);
        const testDetails = c2.stages.find((s) => s.stage === "TEST_DETAILS");
        assert.ok(testDetails);
        assert.equal(testDetails.completed, true);
        assert.equal(testDetails.testResult, "PASS");

        // P0000003: multiple required documents (non-required 'OTHER' filtered out)
        const c3 = byId.get("P0000003");
        assert.equal(c3.documents.length, 3);
        const types = c3.documents.map((d) => d.documentType).sort();
        assert.deepEqual(types, ["MEDICAL", "PASSPORT", "POLICE_REPORT"]);
        const police = c3.documents.find((d) => d.documentType === "POLICE_REPORT");
        assert.equal(police.documentVariant, "SL_VERIFIED");
        assert.equal(police.verificationStatus, "VERIFIED");

        // P0000004: active vs inactive jobs (only active returned)
        const c4 = byId.get("P0000004");
        assert.equal(c4.jobAssignments.length, 1);
        assert.ok(c4.jobAssignments[0].jobId);

        // P0000005: both detailsVerifiedAt and documentsVerifiedAt
        const c5 = byId.get("P0000005");
        assert.ok(c5.verification);
        assert.ok(c5.verification.detailsVerifiedAt);
        assert.ok(c5.verification.documentsVerifiedAt);

        // P0000006: detailsVerifiedAt only
        const c6 = byId.get("P0000006");
        assert.ok(c6.verification);
        assert.ok(c6.verification.detailsVerifiedAt);
        assert.equal(c6.verification.documentsVerifiedAt, null);

        // P0000007: verification row with both null
        const c7 = byId.get("P0000007");
        assert.ok(c7.verification);
        assert.equal(c7.verification.detailsVerifiedAt, null);
        assert.equal(c7.verification.documentsVerifiedAt, null);

        // P0000008: no verification row => null
        const c8 = byId.get("P0000008");
        assert.equal(c8.verification, null);
    });

    test("fetchFallbackCandidateRelations produces identically structured maps as consolidated query", async () => {
        const passportIds = [
            "P0000001", "P0000002", "P0000003", "P0000004",
            "P0000005", "P0000006", "P0000007", "P0000008",
        ];

        // 1. Consolidated query mapping
        const consolidatedRows = await fetchConsolidatedCandidateRelations(prisma, passportIds);
        const cStages = new Map();
        const cDocs = new Map();
        const cJobs = new Map();
        const cVerif = new Map();

        for (const row of consolidatedRows) {
            cStages.set(row.passportId, row.stages || []);
            cDocs.set(row.passportId, row.documents || []);
            cJobs.set(row.passportId, (row.jobAssignments || []).slice(0, 1));
            if (row.verification) {
                const parseDate = (v) => {
                    if (!v) return null;
                    if (v instanceof Date) return v;
                    const s = String(v);
                    return new Date(s.endsWith("Z") || s.includes("+") ? s : s + "Z");
                };
                cVerif.set(row.passportId, {
                    detailsVerifiedAt: parseDate(row.verification.detailsVerifiedAt),
                    documentsVerifiedAt: parseDate(row.verification.documentsVerifiedAt),
                });
            }
        }

        // 2. Fallback query mapping
        const fStages = new Map();
        const fDocs = new Map();
        const fJobs = new Map();
        const fVerif = new Map();

        await fetchFallbackCandidateRelations(prisma, passportIds, {
            stagesByPassport: fStages,
            docsByPassport: fDocs,
            jobsByPassport: fJobs,
            verifByPassport: fVerif,
        });

        // 3. Compare each passport ID
        for (const id of passportIds) {
            const sortStage = (a, b) => a.stage.localeCompare(b.stage);
            const cs = [...(cStages.get(id) || [])].sort(sortStage);
            const fs = [...(fStages.get(id) || [])].sort(sortStage);
            assert.deepEqual(cs, fs, `Stages mismatch for ${id}`);

            const sortDoc = (a, b) => (a.documentType + (a.documentVariant || "")).localeCompare(b.documentType + (b.documentVariant || ""));
            const cd = [...(cDocs.get(id) || [])].sort(sortDoc);
            const fd = [...(fDocs.get(id) || [])].sort(sortDoc);
            assert.deepEqual(cd, fd, `Docs mismatch for ${id}`);

            const cj = cJobs.get(id) || [];
            const fj = fJobs.get(id) || [];
            assert.deepEqual(cj, fj, `Jobs mismatch for ${id}`);

            const cv = cVerif.get(id) || null;
            const fv = fVerif.get(id) || null;
            const cvNorm = cv ? {
                detailsVerifiedAt: cv.detailsVerifiedAt ? cv.detailsVerifiedAt.toISOString() : null,
                documentsVerifiedAt: cv.documentsVerifiedAt ? cv.documentsVerifiedAt.toISOString() : null,
            } : null;
            const fvNorm = fv ? {
                detailsVerifiedAt: fv.detailsVerifiedAt ? fv.detailsVerifiedAt.toISOString() : null,
                documentsVerifiedAt: fv.documentsVerifiedAt ? fv.documentsVerifiedAt.toISOString() : null,
            } : null;
            assert.deepEqual(cvNorm, fvNorm, `Verification mismatch for ${id}`);
        }
    });

    test("listCandidates preserves ordering, pagination, and response structures", async () => {
        let timings = null;
        const res = await listCandidates({
            db: prisma,
            params: { page: 1, pageSize: 10 },
            onTiming: (t) => { timings = t; },
        });

        // Timing reported
        assert.ok(timings);
        assert.equal(typeof timings.baseCandidateDuration, "number");
        assert.equal(typeof timings.consolidatedRelationsDuration, "number");
        assert.equal(typeof timings.totalListFetchDuration, "number");

        // Pagination
        assert.equal(res.pagination.totalItems, 8);
        assert.equal(res.pagination.page, 1);
        assert.equal(res.pagination.pageSize, 10);
        assert.equal(res.pagination.totalPages, 1);

        // Ordering: newest first (P0000008 was registered latest: 17:00)
        assert.equal(res.items[0].passportId, "P0000008");
        assert.equal(res.items[7].passportId, "P0000001");

        // Workflow statuses derived correctly
        const p5 = res.items.find((i) => i.passportId === "P0000005");
        assert.equal(p5.workflowStatus.code, "DOCUMENTS_VERIFIED");

        const p6 = res.items.find((i) => i.passportId === "P0000006");
        assert.equal(p6.workflowStatus.code, "DETAILS_VERIFIED");

        const p4 = res.items.find((i) => i.passportId === "P0000004");
        assert.equal(p4.workflowStatus.code, "JOB_ASSIGNED");

        const p1 = res.items.find((i) => i.passportId === "P0000001");
        assert.equal(p1.workflowStatus.code, "REGISTERED");
    });

    test("GET /api/admin/candidates HTTP endpoint returns compatible API response structure", async () => {
        const app = express();
        app.use(express.json());
        app.use("/api/admin", createAdminRouter({
            db: prisma,
            requireAdmin: (req, res, next) => { req.user = ADMIN; next(); },
            apiLimiter: noRateLimit,
        }));
        app.use(errorHandler);

        const server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });

        try {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/candidates`);
            assert.equal(response.status, 200);
            const body = await response.json();

            assert.equal(body.pagination.totalItems, 8);
            assert.equal(body.items.length, 8);

            // Structure check of each candidate row
            for (const item of body.items) {
                assert.ok(item.passportId);
                assert.ok(item.uniqueId);
                assert.ok(item.name);
                assert.ok(item.workflowStatus);
                assert.ok(item.workflowStatus.code);
                assert.ok(item.workflowStatus.label);
                assert.ok(Array.isArray(item.stages));
                assert.equal(item.stages.length, 8); // 8 stages displayed
                assert.ok(Array.isArray(item.formConflicts));
            }
        } finally {
            server.close();
        }
    });
});
