import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    classifyDocumentContent,
    classifyPoliceSubtype,
    resolveDocumentType,
    classifyDocument,
    DOCUMENT_TYPES,
    CONTENT_CLASSIFICATION_REASONS,
} from "../src/services/documentClassificationService.js";
import { assessDocumentConfidence, DOCUMENT_FLAGS, CONFIDENCE_THRESHOLDS } from "../src/services/confidenceService.js";
import { processDocument } from "../src/services/documentProcessingService.js";
import {
    policeWorkflowEvent,
    policeReportDueDate,
    POLICE_WORKFLOW_EVENT,
    POLICE_REPORT_DUE_DAYS,
} from "../src/services/policeWorkflowService.js";
import { sha256Hex } from "../src/utils/fileChecksum.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";
import { loadDocumentText } from "./helpers/fixtures.js";

const { POLICE_SLIP, POLICE_REPORT, UNKNOWN, PASSPORT } = DOCUMENT_TYPES;

// Synthetic texts only.
const SLIP_TEXT = loadDocumentText("police-slip");         // "Submitted date: 01/09/2026"
const REPORT_TEXT = loadDocumentText("police-clearance");  // final certificate
const slipWith = (dateLine) =>
    `SRI LANKA POLICE - Receipt of application for Police Clearance\nApplication No: PCC/2026/12345\n${dateLine}`;

describe("police classification: slip vs final report", () => {
    test("clear police slip -> POLICE_SLIP", () => {
        const result = classifyDocumentContent(SLIP_TEXT);
        assert.equal(result.documentType, POLICE_SLIP);
        assert.ok(result.indicators.includes("slip_receipt"));
    });

    test("clear police clearance certificate -> POLICE_REPORT", () => {
        const result = classifyDocumentContent(REPORT_TEXT);
        assert.equal(result.documentType, POLICE_REPORT);
        assert.ok(result.indicators.includes("report_no_criminal_record"));
    });

    test("police wording but no slip/report evidence -> UNKNOWN (POLICE_TYPE_UNCLEAR)", () => {
        const result = classifyDocumentContent("SRI LANKA POLICE\nPolice Clearance\nReference No 4411");
        assert.equal(result.documentType, UNKNOWN);
        assert.equal(result.reason, CONTENT_CLASSIFICATION_REASONS.POLICE_TYPE_UNCLEAR);
    });

    test("a single weak keyword never decides the subtype", () => {
        for (const text of [
            "SRI LANKA POLICE\nPolice Clearance\nreceipt",
            "SRI LANKA POLICE\nPolice Clearance\nsubmitted",
            "SRI LANKA POLICE\nPolice Clearance\nClearance Certificate",
        ]) {
            assert.equal(classifyDocumentContent(text).documentType, UNKNOWN, text);
        }
    });

    test("mixed slip and report wording -> UNKNOWN (POLICE_TYPE_UNCLEAR)", () => {
        const mixed = "SRI LANKA POLICE Receipt of application for Police Clearance Certificate. Submitted. " +
            "This is to certify that the applicant has no criminal records.";
        const result = classifyDocumentContent(mixed);
        assert.equal(result.documentType, UNKNOWN);
        assert.equal(result.reason, CONTENT_CLASSIFICATION_REASONS.POLICE_TYPE_UNCLEAR);
        assert.equal(result.policeScores.POLICE_SLIP, result.policeScores.POLICE_REPORT);
    });

    test("classifyPoliceSubtype needs score, two indicators and a lead", () => {
        assert.equal(classifyPoliceSubtype(SLIP_TEXT).documentType, POLICE_SLIP);
        assert.equal(classifyPoliceSubtype(REPORT_TEXT).documentType, POLICE_REPORT);
        assert.equal(classifyPoliceSubtype("police clearance receipt").documentType, null);
    });

    test("non-police documents are classified as before", () => {
        assert.equal(classifyDocumentContent(loadDocumentText("passport-mrz")).documentType, PASSPORT);
        assert.equal(classifyDocumentContent(loadDocumentText("medical-gamca")).documentType, "MEDICAL");
        assert.equal(classifyDocumentContent(loadDocumentText("ambiguous-police-medical")).documentType, UNKNOWN);
    });

    test("an unclear police document is flagged and lands in the UNDEFINED band", () => {
        const contentClassification = classifyDocumentContent("SRI LANKA POLICE\nPolice Clearance\nReference No 4411");
        const resolvedType = resolveDocumentType({ filenameClassification: classifyDocument({ fileName: "police.jpg" }), contentClassification });
        const confidence = assessDocumentConfidence({
            textExtraction: { success: true, method: "PDF_TEXT", text: "x" },
            contentClassification,
            resolvedType,
        });
        assert.ok(confidence.flags.includes(DOCUMENT_FLAGS.POLICE_TYPE_UNCLEAR));
        assert.equal(confidence.band, "UNDEFINED");
    });
});

describe("filename hints for police documents", () => {
    test("slip/receipt names hint POLICE_SLIP; police/clearance names hint POLICE_REPORT", () => {
        assert.equal(classifyDocument({ fileName: "police_slip.jpg" }).documentType, POLICE_SLIP);
        assert.equal(classifyDocument({ fileName: "receipt.pdf" }).documentType, POLICE_SLIP);
        assert.equal(classifyDocument({ fileName: "police.jpg" }).documentType, POLICE_REPORT);
        assert.equal(classifyDocument({ fileName: "clearance.pdf" }).documentType, POLICE_REPORT);
    });

    test("a police-named file is not a wrong document for either police type", () => {
        for (const fileName of ["police.jpg", "police_report.pdf", "police_slip.jpg"]) {
            for (const text of [SLIP_TEXT, REPORT_TEXT]) {
                const resolved = resolveDocumentType({
                    filenameClassification: classifyDocument({ fileName }),
                    contentClassification: classifyDocumentContent(text),
                });
                assert.equal(resolved.filenameMismatch, false, `${fileName}`);
            }
        }
    });

    test("a passport-named file with police content is still suspected as the wrong document", () => {
        const resolved = resolveDocumentType({
            filenameClassification: classifyDocument({ fileName: "passport.pdf" }),
            contentClassification: classifyDocumentContent(REPORT_TEXT),
        });
        assert.equal(resolved.filenameMismatch, true);
    });
});

// Pipeline helpers. N1234567 has WhatsApp 0771234567; N7654321 has 0772223333.
const TEMP_ID = "tmp-p";
const TEMP_PATH = "temporary/tmp-p.pdf";
const FILE = Buffer.from("%PDF-1.4 synthetic police document");
const FILE_SHA = sha256Hex(FILE);
const makeUsers = () => [
    { passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: "KAMAL NIMAL" },
    { passportId: "N7654321", uniqueId: "0002", whatsappNumber: "0772223333", firstName: "NIMAL" },
];
const textRead = (text, confidence) => async () =>
    (confidence === undefined
        ? { success: true, method: "PDF_TEXT", text }
        : { success: true, method: "OCR", text, confidence });

async function run({ text, confidence, sender = "94771234567", users = makeUsers(), documents = [], fileName = "scan.pdf" }) {
    const db = createFakePrisma(users, { documents });
    const bucket = createFakeBucket([TEMP_PATH]);
    const result = await processDocument({
        temporaryId: TEMP_ID,
        whatsappNumber: sender,
        fileName,
        mimeType: "application/pdf",
        fileBuffer: FILE,
        temporaryStoragePath: TEMP_PATH,
        deps: { db, bucket, now: new Date("2026-09-24T07:05:03Z"), extractText: textRead(text, confidence) },
    });
    const recordUpdate = db.calls.filter((c) => c.method === "temporaryData.update").at(-1);
    return { ...result, db, objects: [...bucket.objects.keys()], recordUpdate };
}

const clientObjects = (objects) => objects.filter((path) => path.startsWith("clients/"));

describe("POLICE_SLIP pipeline", () => {
    test("resolved submitted date -> client folder police-slip/, Phase 9 event prepared", async () => {
        const { summary, details, objects, db } = await run({ text: SLIP_TEXT });

        assert.equal(summary.documentType, POLICE_SLIP);
        assert.deepEqual(summary.policeDate, { status: "RESOLVED", kind: "SUBMITTED" });
        assert.equal(summary.storage.placement, "CLIENT");
        assert.ok(objects.includes("clients/N1234567/police-slip/police_slip.pdf"));
        assert.equal(db.documentRows[0].documentType, POLICE_SLIP);
        // Checkpoint 5: the resolved submitted date is stored on the document (DATE column).
        assert.equal(db.documentRows[0].policeSubmittedDate.toISOString(), "2026-09-01T00:00:00.000Z");

        assert.equal(summary.policeWorkflowEvent, POLICE_WORKFLOW_EVENT.SLIP_RECEIVED);
        assert.deepEqual(details.policeWorkflow, {
            event: POLICE_WORKFLOW_EVENT.SLIP_RECEIVED,
            submittedDate: "2026-09-01",
            dueDate: "2026-09-22",
        });
        assert.ok(!JSON.stringify(summary).includes("2026-09-01"), "no dates in the loggable summary");
        assert.ok(!JSON.stringify(summary).includes("2026-09-22"));
    });

    const unresolved = [
        ["ambiguous (two different submitted dates)", slipWith("Submitted date: 01/09/2026  Received date: 03/09/2026"), "AMBIGUOUS"],
        ["not found", slipWith("Name: K. Perera"), "NOT_FOUND"],
        ["invalid (future date)", slipWith("Submitted date: 01/12/2099"), "INVALID"],
    ];
    for (const [name, text, status] of unresolved) {
        test(`${name} -> MANUAL_REVIEW, pending, no countdown event`, async () => {
            const { summary, objects, recordUpdate, details } = await run({ text });

            assert.equal(summary.documentType, POLICE_SLIP);
            assert.equal(summary.policeDate.status, status);
            assert.equal(summary.processingStatus, "MANUAL_REVIEW");
            assert.equal(summary.storage.placement, "PENDING");
            assert.ok(recordUpdate.data.pendingStoragePath.startsWith("pending/0001/"));
            assert.deepEqual(clientObjects(objects), []);
            assert.equal(summary.policeWorkflowEvent, null);
            assert.equal(details.policeWorkflow, null);
        });
    }
});

describe("POLICE_REPORT pipeline", () => {
    test("unique WhatsApp match + good confidence -> client folder police-report/, no date needed", async () => {
        const { summary, details, objects, db, recordUpdate } = await run({ text: REPORT_TEXT });

        assert.equal(summary.documentType, POLICE_REPORT);
        assert.equal(summary.policeDate, null);
        assert.equal(details.policeDate, null);
        assert.equal(summary.identity.status, "WHATSAPP_MATCH_ONLY");
        assert.equal(summary.storage.placement, "CLIENT");
        assert.equal(summary.storage.verificationStatus, "VERIFIED");
        assert.ok(objects.includes("clients/N1234567/police-report/police_report.pdf"));
        assert.equal(db.documentRows[0].documentType, POLICE_REPORT);
        assert.equal(db.documentRows[0].policeSubmittedDate, null, "only slips keep a submitted date");
        assert.equal(recordUpdate.data.passportId, "N1234567");
        assert.equal(summary.policeWorkflowEvent, POLICE_WORKFLOW_EVENT.REPORT_RECEIVED);
    });

    test("dates on the report never block it (even an unreadable or future one)", async () => {
        const text = `${REPORT_TEXT}\nPeriod 01/01/1990 to 05/05/2026. Printed 31/12/2099`;
        const { summary } = await run({ text });
        assert.equal(summary.policeDate, null);
        assert.equal(summary.storage.placement, "CLIENT");
    });

    test("uncertain but acceptable quality (UNCLEAR) -> client folder, REVIEW_REQUIRED", async () => {
        const { summary, db } = await run({ text: REPORT_TEXT, confidence: 50 });
        assert.equal(summary.confidence.band, "UNCLEAR");
        assert.equal(summary.storage.placement, "CLIENT");
        assert.equal(summary.storage.verificationStatus, "REVIEW_REQUIRED");
        assert.equal(db.documentRows[0].verificationStatus, "REVIEW_REQUIRED");
        assert.equal(summary.confidence.document, 50, "measured confidence kept");
    });

    test("SLIGHTLY_UNCLEAR (OCR ~67-71, like the real reports) -> client folder", async () => {
        const { summary } = await run({ text: REPORT_TEXT, confidence: 67 });
        assert.equal(summary.confidence.band, "SLIGHTLY_UNCLEAR");
        assert.equal(summary.storage.placement, "CLIENT");
    });

    test("UNDEFINED confidence -> pending, no workflow event", async () => {
        const { summary, objects } = await run({ text: REPORT_TEXT, confidence: 30 });
        assert.equal(summary.processingStatus, "UNDEFINED");
        assert.equal(summary.storage.placement, "PENDING");
        assert.deepEqual(clientObjects(objects), []);
        assert.equal(summary.policeWorkflowEvent, null);
    });

    test("same client, same file -> DUPLICATE (unchanged)", async () => {
        const documents = [{ documentId: "d1", passportId: "N1234567", documentType: POLICE_REPORT, fileSha256: FILE_SHA }];
        const { summary, objects } = await run({ text: REPORT_TEXT, documents });
        assert.equal(summary.processingStatus, "DUPLICATE");
        assert.deepEqual(objects, [TEMP_PATH]);
        assert.equal(summary.policeWorkflowEvent, null);
    });

    test("same file stored for another client -> CONFLICT in pending/unidentified (unchanged)", async () => {
        const documents = [{ documentId: "d9", passportId: "N7654321", documentType: POLICE_REPORT, fileSha256: FILE_SHA }];
        const { summary, objects, recordUpdate } = await run({ text: REPORT_TEXT, documents });
        assert.equal(summary.processingStatus, "CONFLICT");
        assert.deepEqual(clientObjects(objects), []);
        assert.ok(recordUpdate.data.pendingStoragePath.startsWith(`pending/unidentified/${TEMP_ID}/`));
    });

    test("a second different report becomes police_report_v2 (versioning unchanged)", async () => {
        const documents = [{ documentId: "d1", passportId: "N1234567", documentType: POLICE_REPORT, fileSha256: "0".repeat(64), storagePath: "clients/N1234567/police-report/police_report.pdf" }];
        const db = createFakePrisma(makeUsers(), { documents });
        const bucket = createFakeBucket([TEMP_PATH, "clients/N1234567/police-report/police_report.pdf"]);
        await processDocument({
            temporaryId: TEMP_ID, whatsappNumber: "94771234567", fileName: "scan.pdf", mimeType: "application/pdf",
            fileBuffer: FILE, temporaryStoragePath: TEMP_PATH,
            deps: { db, bucket, now: new Date("2026-09-24T07:05:03Z"), extractText: textRead(REPORT_TEXT) },
        });
        assert.ok(bucket.objects.has("clients/N1234567/police-report/police_report_v2.pdf"));
        assert.ok(bucket.objects.has("clients/N1234567/police-report/police_report.pdf"), "existing file kept");
    });
});

describe("police identity (non-passport rules unchanged)", () => {
    test("one WhatsApp match -> WHATSAPP_MATCH_ONLY, linked", async () => {
        const { summary, recordUpdate } = await run({ text: REPORT_TEXT });
        assert.equal(summary.identity.status, "WHATSAPP_MATCH_ONLY");
        assert.equal(recordUpdate.data.uniqueId, "0001");
    });

    test("several clients share the number -> AMBIGUOUS_MATCH, pending, not linked", async () => {
        const users = makeUsers();
        users[1].whatsappNumber = "0771234567";
        const { summary, objects, recordUpdate } = await run({ text: REPORT_TEXT, users });
        assert.equal(summary.identity.status, "AMBIGUOUS_MATCH");
        assert.equal(summary.storage.placement, "PENDING");
        assert.deepEqual(clientObjects(objects), []);
        assert.equal(recordUpdate.data.passportId, undefined);
    });

    test("unknown number -> NO_MATCH, pending, not linked", async () => {
        const { summary, objects, recordUpdate } = await run({ text: REPORT_TEXT, sender: "94779999999" });
        assert.equal(summary.identity.status, "NO_MATCH");
        assert.equal(summary.storage.placement, "PENDING");
        assert.deepEqual(clientObjects(objects), []);
        assert.equal(recordUpdate.data.passportId, undefined);
    });

    test("unclear police subtype -> UNDEFINED, pending under the client, flagged", async () => {
        const { summary, objects, recordUpdate } = await run({ text: "SRI LANKA POLICE\nPolice Clearance\nReference No 4411" });
        assert.equal(summary.documentType, UNKNOWN);
        assert.ok(summary.confidence.flags.includes(DOCUMENT_FLAGS.POLICE_TYPE_UNCLEAR));
        assert.equal(summary.storage.placement, "PENDING");
        assert.ok(recordUpdate.data.pendingStoragePath.startsWith("pending/0001/"));
        assert.deepEqual(clientObjects(objects), []);
    });
});

describe("Police Workflow data (Phase 9 events are still only prepared)", () => {
    test("due date = submitted date + 21 days", () => {
        assert.equal(POLICE_REPORT_DUE_DAYS, 21);
        assert.equal(policeReportDueDate("2026-09-01"), "2026-09-22");
        assert.equal(policeReportDueDate("2026-12-20"), "2027-01-10");
        assert.equal(policeReportDueDate("2028-02-15"), "2028-03-07"); // leap year
    });

    test("events only for documents filed under the client", () => {
        const resolved = { status: "RESOLVED", date: "2026-09-01" };
        assert.equal(policeWorkflowEvent({ documentType: POLICE_SLIP, policeDate: resolved, placement: "PENDING" }), null);
        assert.equal(policeWorkflowEvent({ documentType: POLICE_SLIP, policeDate: { status: "AMBIGUOUS" }, placement: "CLIENT" }), null);
        assert.equal(policeWorkflowEvent({ documentType: POLICE_REPORT, policeDate: null, placement: "NONE" }), null);
        assert.equal(policeWorkflowEvent({ documentType: "MEDICAL", policeDate: null, placement: "CLIENT" }), null);
        assert.deepEqual(policeWorkflowEvent({ documentType: POLICE_REPORT, policeDate: null, placement: "CLIENT" }), { event: "POLICE_REPORT_RECEIVED" });
    });
});

describe("regression guards", () => {
    test("global confidence thresholds unchanged", () => {
        assert.deepEqual(CONFIDENCE_THRESHOLDS, { VERIFIED_ABOVE: 95, HIGH_CONFIDENCE_FROM: 90, SLIGHTLY_UNCLEAR_FROM: 60, UNCLEAR_FROM: 40 });
    });

    test("medical documents never get a police date or workflow event", async () => {
        const { summary } = await run({ text: loadDocumentText("medical-gamca") });
        assert.equal(summary.documentType, "MEDICAL");
        assert.equal(summary.policeDate, null);
        assert.equal(summary.policeWorkflowEvent, null);
    });

    test("medical documents never get a police submitted date stored", async () => {
        const { db } = await run({ text: loadDocumentText("medical-gamca") });
        for (const row of db.documentRows) assert.equal(row.policeSubmittedDate, null);
    });
});
