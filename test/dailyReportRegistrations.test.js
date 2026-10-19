// Daily Report: Candidates Registered (dailyReportService.js). On a REAL
// PostgreSQL (PGlite, every migration) through the real Prisma client and
// the real registration flow (createCandidate, which records who registered
// the candidate). Synthetic data only.
//
// Report day 2026-10-12 in Sri Lanka = 2026-10-11T18:30:00Z up to (not
// including) 2026-10-12T18:30:00Z.
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { createCandidate, parseCandidateBody } from "../src/services/candidateService.js";
import { getDailySummary } from "../src/services/dailyReportService.js";

const DAY = "2026-10-12";
const START = "2026-10-11T18:30:00.000Z"; // 00:00 Colombo
const LAST_MS = "2026-10-12T18:29:59.999Z"; // 23:59:59.999 Colombo
const NEXT = "2026-10-12T18:30:00.000Z"; // 13 Oct 00:00 Colombo
const BEFORE = "2026-10-11T18:29:59.999Z"; // 11 Oct 23:59:59.999 Colombo
const NOW = new Date("2026-10-13T06:00:00.000Z");

const DESK = { adminId: "user-desk", authUserId: "00000000-0000-4000-8000-000000000004", name: "Dee Desk", email: "dee@example.invalid", role: "REGISTRATION_DESK" };
const ANALYST = { adminId: "user-analyst", authUserId: "00000000-0000-4000-8000-000000000003", name: "Ann Analyst", email: "ann@example.invalid", role: "ANALYST" };

let database;
let prisma;

// Registers through the real flow, then sets when it happened.
async function register(passportId, otherNames, nic, whatsappNumber, at, actor) {
    const { values } = parseCandidateBody({
        passportId, surname: "Perera", otherNames, nic, whatsappNumber, jobTypes: ["Driver"], jobExperience: "1 year",
        passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14",
    }, { creating: true });
    await createCandidate({ db: prisma, values, actor });
    await prisma.candidate.update({ where: { passportId }, data: { createdDate: new Date(at) } });
}

async function addDocument(passportId, documentType, at, status = "VERIFIED") {
    const documentId = crypto.randomUUID();
    await prisma.document.create({
        data: {
            documentId, passportId, documentType, originalFilename: "f.pdf", storedFilename: `${documentId}.pdf`, storagePath: `clients/${passportId}/${documentId}.pdf`,
            receivedDate: new Date(at), processingStatus: "STORED", verificationStatus: status,
        },
    });
}

before(async () => {
    database = await createTestDatabase();
    ({ prisma } = database);
    for (const user of [DESK, ANALYST]) await prisma.user.create({ data: user });
    // On the day: R1 at 00:00 with NO documents (desk); R2 mid-day with two
    // documents, one superseded (analyst); R3 at 23:59:59.999 with no audit
    // entry (registered before registrations were audited).
    await register("R0000001", "Nimal", "900000011V", "+94771110001", START, DESK);
    await register("R0000002", "Sunil", "900000012V", "+94771110002", "2026-10-12T05:00:00Z", ANALYST);
    await register("R0000003", "Kamal", "900000013V", "+94771110003", LAST_MS, null);
    await addDocument("R0000002", "PASSPORT", "2026-10-12T05:10:00Z");
    await addDocument("R0000002", "MEDICAL", "2026-10-12T05:20:00Z", "SUPERSEDED");
    await addDocument("R0000002", "MEDICAL", "2026-10-12T05:30:00Z");
    // Outside the day on either side.
    await register("R0000004", "Saman", "900000014V", "+94771110004", BEFORE, DESK);
    await register("R0000005", "Ruwan", "900000015V", "+94771110005", NEXT, DESK);
});
after(async () => database?.close());

const report = (date = DAY) => getDailySummary({ db: prisma, date, now: NOW });
const item = (r, passportId) => r.registeredCandidates.items.find((c) => c.passportId === passportId);

describe("Candidates Registered", () => {
    test("1-3. a candidate registered with no documents counts and is listed; Documents Submitted stays independent", async () => {
        const r = await report();
        const r1 = item(r, "R0000001");
        assert.ok(r1, "listed");
        assert.equal(r1.documents, 0);
        // The day's documents come from document activity only: here, none
        // were submitted through WhatsApp or the upload flow (the two rows
        // above were written directly), so the registrations add nothing.
        assert.equal(r.summary.documentsSubmitted, 0);
        assert.equal(r.summary.candidatesRegistered, 3);
    });

    test("4-5. a candidate with documents counts once; the count does not depend on documents", async () => {
        const r = await report();
        assert.equal(r.registeredCandidates.items.filter((c) => c.passportId === "R0000002").length, 1);
        assert.equal(item(r, "R0000002").documents, 2, "current documents, superseded not counted");
        assert.equal(r.registeredCandidates.total, 3);
    });

    test("6-8. the selected day decides, on Sri Lanka midnight boundaries", async () => {
        assert.deepEqual((await report()).registeredCandidates.items.map((c) => c.passportId).sort(), ["R0000001", "R0000002", "R0000003"]);
        const previous = await report("2026-10-11");
        assert.deepEqual(previous.registeredCandidates.items.map((c) => c.passportId), ["R0000004"], "23:59:59.999 on the 11th belongs to the 11th");
        const next = await report("2026-10-13");
        assert.deepEqual(next.registeredCandidates.items.map((c) => c.passportId), ["R0000005"], "00:00 on the 13th belongs to the 13th");
    });

    test("9-12. each row: passport number, name, registration time, who registered (when recorded) and progress", async () => {
        const r = await report();
        const r1 = item(r, "R0000001");
        assert.deepEqual([r1.name, new Date(r1.registeredAt).toISOString(), r1.registeredBy, r1.registeredByRole], ["Nimal Perera", START, "Dee Desk", "REGISTRATION_DESK"]);
        assert.equal(item(r, "R0000002").registeredBy, "Ann Analyst");
        assert.equal(item(r, "R0000003").registeredBy, null, "no registration entry: not invented");
        assert.equal(r1.stagesTotal, 8);
        assert.ok(r1.stagesComplete >= 0 && r1.stagesComplete < 7);
        assert.deepEqual(r.registeredCandidates.items.map((c) => c.passportId), ["R0000003", "R0000002", "R0000001"], "newest first");
    });

    test("16. a day without registrations: zero and an empty list", async () => {
        const r = await report("2026-10-01");
        assert.equal(r.summary.candidatesRegistered, 0);
        assert.deepEqual(r.registeredCandidates, { total: 0, items: [], truncated: false });
    });
});
