// Candidate phone numbers: one canonical STORAGE form (+<country code><number>), one COMPARISON
// key (phoneKey), and the database's normalized uniqueness (migration 20261104120000).
// SYNTHETIC numbers only. Real PostgreSQL (PGlite) for everything that touches the database.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { authIdFor } from "./helpers/fakeSupabaseAuth.js";
import { canonicalPhoneNumber, normalizePhoneNumber, phoneKey } from "../src/utils/phoneNumber.js";
import { createCandidate, parseCandidateBody, updateCandidateDetails } from "../src/services/candidateService.js";
import { findUsersByWhatsappNumber, LOOKUP_STATUS } from "../src/services/userLookupService.js";
import { commitChunk, finishImport, previewImport } from "../src/services/candidateImportService.js";
import { normalizePhones } from "../src/services/candidateImportNormalizers.js";
import { analyzeCandidatePhones, canonicalizeCandidatePhones } from "../src/services/candidatePhoneAudit.js";
import { mapCandidateToSheetRow } from "../src/services/candidateSheetMapper.js";
import { createCandidateAggregateReader } from "../src/services/candidateAggregateReader.js";
import { SHEET_COLUMNS } from "../src/services/sheetSchema.js";

const ADMIN = { adminId: "phone-admin", role: "ADMIN" };
const MIGRATION = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations", "20261104120000_candidate_whatsapp_normalized_unique", "migration.sql");

describe("canonical storage form and comparison key", () => {
    test("Sri Lankan forms: 077..., 77... (Excel), 9477..., +9477..., 0094..., spaced -> +9477...; key 9477...", () => {
        for (const input of ["0771234567", "771234567", "94771234567", "+94771234567", "0094771234567", "+94 77 123 4567", "077-123-4567"]) {
            assert.equal(canonicalPhoneNumber(input), "+94771234567", input);
            assert.equal(phoneKey(input), "94771234567", input);
        }
    });

    test("an already canonical number is unchanged", () => {
        assert.equal(canonicalPhoneNumber("+94771234567"), "+94771234567");
        assert.equal(canonicalPhoneNumber("+40712345678"), "+40712345678");
    });

    test("foreign numbers keep their own country code (never +94)", () => {
        assert.equal(canonicalPhoneNumber("+40 712 345 678"), "+40712345678");
        assert.equal(canonicalPhoneNumber("40712345678"), "+40712345678");
        assert.equal(canonicalPhoneNumber("0049 151 12345678"), "+4915112345678");
        assert.equal(canonicalPhoneNumber("+971501234567"), "+971501234567");
    });

    test("a Sri Lankan 10-digit landline is +94; numbers that can't be made international are refused", () => {
        assert.equal(canonicalPhoneNumber("011 234 5678"), "+94112345678");
        for (const bad of ["0123456", "012345678", "abc", "", null, "1234567"]) assert.equal(canonicalPhoneNumber(bad), null, String(bad));
    });

    test("the key equals the WhatsApp sender comparison for every mobile form (WhatsApp matching is unchanged)", () => {
        for (const input of ["94771234567", "+94771234567", "0771234567", "40712345678"]) assert.equal(phoneKey(input), normalizePhoneNumber(input), input);
    });

    test("bulk import produces exactly the registration form", () => {
        for (const input of ["0771234567", "+94771234567", "40712345678", "011 234 5678"]) {
            assert.deepEqual(normalizePhones(input).numbers, [canonicalPhoneNumber(input)], input);
        }
    });
});

describe("database", () => {
    let database;
    let prisma;
    let pg;
    before(async () => {
        database = await createTestDatabase();
        ({ prisma, pg } = database);
        await prisma.user.create({ data: { adminId: ADMIN.adminId, authUserId: authIdFor(ADMIN.adminId), name: "Phone", email: "phone@example.invalid", role: "ADMIN", status: "ACTIVE" } });
    });
    after(async () => database?.close());
    beforeEach(async () => {
        await pg.exec(`DELETE FROM "candidate_import"; DELETE FROM "candidate_verification"; DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";`);
    });

    // An older record, stored in the previous digits-only form (bypassing the application).
    const legacy = (n, whatsappNumber, extra = {}) => prisma.candidate.create({ data: { passportId: `SYNL${String(n).padStart(4, "0")}`, uniqueId: String(n).padStart(4, "0"), firstName: "LEGACY", whatsappNumber, ...extra } });
    const register = async (passportId, whatsappNumber, nic = "900000001V") => {
        const { values, errors } = parseCandidateBody({ passportId, surname: "SYNTH", otherNames: "SYNTH", nic, whatsappNumber, jobTypes: ["PLASTER"] }, { creating: true });
        assert.equal(errors, undefined);
        return createCandidate({ db: prisma, values, actor: ADMIN });
    };

    test("the SQL key function and phoneKey agree on every form", async () => {
        const inputs = ["0771234567", "771234567", "94771234567", "+94771234567", "0094771234567", "+94 77 123 4567", "011 234 5678", "+40712345678", "4915112345678",
            "0123456", "012345678", "abc", "", "1234567", "+1234567890123456"];
        for (const input of inputs) {
            const [{ key }] = await prisma.$queryRaw`SELECT candidate_phone_key(${input}) AS key`;
            assert.equal(key, phoneKey(input), JSON.stringify(input));
        }
    });

    test("database uniqueness is by the number: +9477..., 9477... and 077... can't be held twice; the exempt number still can", async () => {
        await legacy(1, "94771234567");
        for (const [n, form] of [[2, "+94771234567"], [3, "0771234567"], [4, "+94 77 123 4567"]]) {
            await assert.rejects(legacy(n, form), (e) => e.code === "P2002" && /whatsapp/.test(String(e.meta?.target)), form);
        }
        await legacy(5, "+40712345678");
        await legacy(6, "+94771581916");
        await legacy(7, "94771581916");
        assert.equal(await prisma.candidate.count(), 4);
    });

    test("registration stores +<country code> and refuses a number already held in the older form", async () => {
        await legacy(1, "94771234567");
        await assert.rejects(register("N9100001", "0771234567"), (e) => e.code === "WHATSAPP_EXISTS");
        await assert.rejects(register("N9100002", "+94771234567", "900000002V"), (e) => e.code === "WHATSAPP_EXISTS");
        await register("N9100003", "40712345678", "900000003V");
        const stored = await prisma.candidate.findUnique({ where: { passportId: "N9100003" } });
        assert.equal(stored.whatsappNumber, "+40712345678");
    });

    test("candidate update: adding a number held by another candidate (older form) is refused; a record's own number in the older form is not a change", async () => {
        await legacy(1, "94771234567");
        await legacy(2, null);
        const values = (whatsappNumber) => parseCandidateBody({ surname: "SYNTH", otherNames: "SYNTH", nic: "900000009V", jobExperience: "1", passportIssueDate: "2020-01-01", passportExpiryDate: "2030-01-01", jobTypes: ["PLASTER"], whatsappNumber }, { creating: false }).values;
        await assert.rejects(updateCandidateDetails({ db: prisma, passportId: "SYNL0002", values: values("+94771234567"), actor: ADMIN }), (e) => e.code === "WHATSAPP_EXISTS");
        const same = await updateCandidateDetails({ db: prisma, passportId: "SYNL0001", values: { ...values("0771234567"), nic: "900000008V" }, actor: ADMIN });
        assert.equal(same.candidate.whatsappNumber, "94771234567", "the stored value is not rewritten by a resubmission");
        const added = await updateCandidateDetails({ db: prisma, passportId: "SYNL0002", values: values("0779999999"), actor: ADMIN });
        assert.equal(added.candidate.whatsappNumber, "+94779999999");
    });

    test("bulk import: a number held in the older form is a WHATSAPP_CONFLICT (imported without it)", async () => {
        await legacy(1, "94771234567");
        const rows = [{ rowNumber: 2, values: { "PASSPORT NUMBER": "N9200001", SURNAME: "SYNTH", "OTHER NAME": "SYNTH", "WHATSAPP NUMBER": "+94 77 123 4567" } }];
        const p = await previewImport({ db: prisma, actor: ADMIN, fileName: "synthetic.xlsx", headers: ["PASSPORT NUMBER", "SURNAME", "OTHER NAME", "WHATSAPP NUMBER"], rows });
        assert.equal(p.summary.whatsappConflicts, 1);
        await commitChunk({ db: prisma, actor: ADMIN, importId: p.importId, chunkIndex: 0, rows });
        await finishImport({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: "N9200001" } })).whatsappNumber, null);
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: "SYNL0001" } })).whatsappNumber, "94771234567");
    });

    test("user lookup (WhatsApp sender 9477...) finds a candidate in either stored form", async () => {
        await legacy(1, "94771234567");
        await register("N9100004", "0779999999", "900000004V");
        for (const [sender, passportId] of [["94771234567", "SYNL0001"], ["+94771234567", "SYNL0001"], ["94779999999", "N9100004"]]) {
            const { status, users } = await findUsersByWhatsappNumber(sender, { db: prisma });
            assert.equal(status, LOOKUP_STATUS.FOUND, sender);
            assert.equal(users[0].passportId, passportId);
        }
    });

    test("the mirror shows the stored canonical value", async () => {
        const { uniqueId } = await register("N9100005", "077 123 4567");
        const aggregate = await createCandidateAggregateReader({ db: prisma }).findByUniqueId(uniqueId);
        const row = mapCandidateToSheetRow(aggregate, { mirroredAt: new Date() });
        assert.equal(row[SHEET_COLUMNS.find((c) => c.header === "WHATSAPP NUMBER").index], "+94771234567");
    });

    test("audit: count-only analysis; the backfill rewrites safe rows only (not verified, not unnormalizable) and is idempotent", async () => {
        await legacy(1, "94771234567", { contactNumber: "0112345678" });   // to canonicalize (both)
        await legacy(2, "+94779999999");                                   // already canonical
        await legacy(3, "40712345678");                                    // foreign, to canonicalize
        await legacy(4, "12345");                                          // can't be normalized
        await legacy(5, "0778888888");                                     // verified: left as it is
        await prisma.candidateVerification.create({ data: { passportId: "SYNL0005", detailsVerifiedAt: new Date(), detailsVerifiedById: ADMIN.adminId } });

        const analysis = await analyzeCandidatePhones(prisma);
        assert.deepEqual(
            [analysis.whatsapp.total, analysis.whatsapp.withPlus, analysis.whatsapp.withoutPlus, analysis.whatsapp.alreadyCanonical, analysis.whatsapp.toCanonicalize, analysis.whatsapp.cannotNormalize, analysis.whatsapp.verifiedToCanonicalize],
            [5, 1, 4, 1, 3, 1, 1],
        );
        assert.deepEqual(analysis.whatsapp.countryCodes, { "94 (Sri Lanka)": 3, "40 (Romania)": 1 });
        assert.equal(analysis.duplicateGroups, 0);
        assert.deepEqual(analysis.cannotNormalize.whatsapp, ["0004"]);
        assert.ok(!JSON.stringify(analysis).match(/7712|7999|7123|8888|2345678/), "no number in the output");

        const dry = await canonicalizeCandidatePhones(prisma, { dryRun: true });
        assert.deepEqual([dry.whatsappUpdated, dry.contactUpdated, dry.skippedVerified], [2, 1, 1]);
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: "SYNL0001" } })).whatsappNumber, "94771234567", "a dry run writes nothing");

        const applied = await canonicalizeCandidatePhones(prisma, { dryRun: false });
        assert.deepEqual([applied.whatsappUpdated, applied.contactUpdated, applied.skippedVerified, applied.changedMeanwhile], [2, 1, 1, 0]);
        const byId = Object.fromEntries((await prisma.candidate.findMany()).map((c) => [c.uniqueId, [c.whatsappNumber, c.contactNumber]]));
        assert.deepEqual(byId, {
            "0001": ["+94771234567", "+94112345678"], "0002": ["+94779999999", null], "0003": ["+40712345678", null], "0004": ["12345", null], "0005": ["0778888888", null],
        });
        assert.ok((await prisma.candidateVerification.findUnique({ where: { passportId: "SYNL0005" } })).detailsVerifiedAt, "verification kept");
        const again = await canonicalizeCandidatePhones(prisma, { dryRun: false });
        assert.deepEqual([again.whatsappUpdated, again.contactUpdated], [0, 0]);
    });
});

describe("migration 20261104120000 safety", () => {
    test("with the same number held twice in different forms it stops before changing anything, reporting counts only; once resolved it applies", async () => {
        const database = await createTestDatabase({ upTo: "20261103120000_candidate_import" });
        try {
            const { pg } = database;
            await pg.exec(`INSERT INTO "candidate" ("passport_id", "unique_id", "first_name", "whatsapp_number", "updated_date") VALUES
                ('SYNM0001', '0001', 'A', '94771234567', now()), ('SYNM0002', '0002', 'B', '+94771234567', now()), ('SYNM0003', '0003', 'C', '+94779999999', now());`);
            const sql = fs.readFileSync(MIGRATION, "utf8");
            await assert.rejects(pg.exec(sql), (e) => /1 group\(s\) \(2 candidates\)/.test(e.message) && !/77123|94771234567/.test(e.message));
            const indexes = await pg.query(`SELECT indexname FROM pg_indexes WHERE indexname = 'candidate_whatsapp_number_key_normalized'`);
            assert.equal(indexes.rows.length, 0, "nothing was created");
            await pg.exec(`UPDATE "candidate" SET "whatsapp_number" = NULL WHERE "passport_id" = 'SYNM0002'`);
            await pg.exec(sql);
            const created = await pg.query(`SELECT indexname FROM pg_indexes WHERE indexname = 'candidate_whatsapp_number_key_normalized'`);
            assert.equal(created.rows.length, 1);
        } finally {
            await database.close();
        }
    });
});
