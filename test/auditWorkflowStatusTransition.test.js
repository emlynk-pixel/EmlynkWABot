// scripts/auditWorkflowStatusTransition.mjs: the read-only dry run of the Candidates tab Status order, run
// against a disposable PostgreSQL (PGlite, every migration applied). Synthetic candidates only.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { giveTestPassAndJob } from "./helpers/visaPrerequisites.js";
import { ACK_VALUE, ACK_VARIABLE, auditWorkflowStatusTransition, refusalReason } from "../scripts/auditWorkflowStatusTransition.mjs";

let database;
let prisma;

before(async () => { database = await createTestDatabase(); ({ prisma } = database); });
after(async () => database?.close());

const REQUIRED = [["PASSPORT"], ["MEDICAL"], ["SCAN"], ["POLICE_REPORT", "SL_VERIFIED"], ["POLICE_REPORT", "ROMANIA"]];
let documents = 0;
const addAllDocuments = async (passportId) => {
    for (const [documentType, documentVariant = null] of REQUIRED) {
        documents += 1;
        await prisma.document.create({ data: {
            documentId: `doc-${documents}`, passportId, documentType, documentVariant, originalFilename: "f.pdf", storedFilename: "f.pdf",
            storagePath: `p/${documents}.pdf`, receivedDate: new Date(), processingStatus: "PROCESSED", verificationStatus: "VERIFIED",
        } });
    }
};

describe("workflow Status transition audit (read-only dry run)", () => {
    test("counts OLD -> NEW per manual / imported candidate, codes only, and writes nothing", async () => {
        const admin = await prisma.user.create({ data: { adminId: "u-admin", authUserId: "00000000-0000-4000-8000-000000000001", name: "Admin", email: "a@example.invalid", role: "ADMIN" } });
        await prisma.candidate.createMany({ data: [
            { passportId: "M0000001", uniqueId: "8001", firstName: "Manual" },
            { passportId: "M0000002", uniqueId: "8002", firstName: "Manual" },
            { passportId: "I0000001", uniqueId: "9001", firstName: "Imported" },
        ] });
        // Manual: every document but no test result (was Visa Document Ready, now Registered); one untouched (Registered).
        await addAllDocuments("M0000001");
        // Imported: a PASS, a Job and VISA STATUS "Submit" (Visa Submitted, before and after).
        await giveTestPassAndJob(prisma, "I0000001", admin.adminId);
        await prisma.candidateStage.create({ data: { passportId: "I0000001", stage: "VISA_SUBMISSION", completed: true, completedAt: new Date() } });
        const importId = crypto.randomUUID();
        await prisma.candidateImport.create({ data: { importId, adminId: admin.adminId, fileName: "sheet.xlsx", status: "COMPLETED", totalRows: 1, chunkSize: 100, chunkHashes: [] } });
        await prisma.candidateImportChange.create({ data: {
            importId, chunkIndex: 0, entityType: "CANDIDATE", entityKey: "9001", candidateUniqueId: "9001", op: "CREATE", preExisting: false,
            rollbackAction: "NONE", changesDigest: "d",
        } });
        const counts = { candidates: await prisma.candidate.count(), stages: await prisma.candidateStage.count() };

        const result = await auditWorkflowStatusTransition(prisma);
        assert.deepEqual(result, {
            total: 3,
            changed: 1,
            manual: { candidates: 2, changed: 1, transitions: { "REGISTERED -> REGISTERED": 1, "VISA_DOCUMENT_READY -> REGISTERED": 1 } },
            imported: { candidates: 1, changed: 0, transitions: { "VISA_SUBMITTED -> VISA_SUBMITTED": 1 } },
        });
        assert.doesNotMatch(JSON.stringify(result), /M000|I000|8001|9001|Manual|Imported/, "no identifiers");
        assert.deepEqual({ candidates: await prisma.candidate.count(), stages: await prisma.candidateStage.count() }, counts);
    });

    test("the transaction is READ ONLY: a write inside it is refused", async () => {
        await assert.rejects(prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
            await tx.candidate.create({ data: { passportId: "X0000001", uniqueId: "9999", firstName: "X" } });
        }), /read-only/i);
    });

    test("refuses production and non-local hosts unless acknowledged", () => {
        assert.match(refusalReason({ NODE_ENV: "production", DATABASE_URL: "postgresql://u@localhost/db" }), /production/);
        assert.match(refusalReason({ DATABASE_URL: "postgresql://u@db.remote.example/db" }), /not a local database/);
        assert.match(refusalReason({}), /not set/);
        assert.equal(refusalReason({ DATABASE_URL: "postgresql://u@127.0.0.1:5432/db" }), null);
        assert.equal(refusalReason({ NODE_ENV: "production", DATABASE_URL: "postgresql://u@db.remote.example/db", [ACK_VARIABLE]: ACK_VALUE }), null);
        assert.doesNotMatch(refusalReason({ DATABASE_URL: "postgresql://secret@db.remote.example/db" }), /secret|remote/, "never echoes the URL");
    });
});
