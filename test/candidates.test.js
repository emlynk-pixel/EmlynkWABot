// Admin > Candidates: registration, details, independent stages, uploads,
// call log, and the routes' role rules. In-memory fakes only: no database,
// no Supabase.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import {
    CANDIDATE_STAGES,
    REQUIRED_SUBMISSION_DOCUMENTS,
    addCallLog,
    createCandidate,
    formatJobTypes,
    getCandidate,
    listCandidates,
    originalFileNameFrom,
    parseCandidateBody,
    parseJobTypes,
    parseStageBody,
    parseUploadQuery,
    resolveCandidatePassportId,
    updateCandidateDetails,
    updateStage,
    uploadCandidateDocument,
    validateCandidateUpload,
    CandidateError,
} from "../src/services/candidateService.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";

const ADMIN = { adminId: "admin-1", name: "Test Admin", role: "ADMIN", status: "ACTIVE" };
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(64)]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  "), Buffer.alloc(64)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

const VALID_BODY = Object.freeze({
    passportId: "n1023757",
    surname: "De Soysa",
    otherNames: "Anusha",
    nic: "965404378v",
    address: "Negombo, Sri Lanka",
    jobTypes: ["Construction Worker", "Caregiver", "Electrician"],
    jobExperience: "5 years in overseas construction",
    dateOfBirth: "1996-02-23",
    comment: "Prefers morning calls",
});

// Just enough of Prisma for candidateService.js.
function createFakeDb({ users = [], documents = [], stages = [], callLogs = [], admins = [ADMIN] } = {}) {
    const state = { users: users.map((u) => ({ ...u })), documents: [...documents], stages: [...stages], callLogs: [...callLogs], auditLogs: [], admins };
    const unique = (code, target) => Object.assign(new Error("Unique constraint failed"), { code, meta: { target } });
    const matches = (row, where = {}) => Object.entries(where).every(([key, condition]) => {
        if (key === "OR") return condition.some((c) => matches(row, c));
        if (key === "AND") return condition.every((c) => matches(row, c));
        const value = row[key];
        if (condition && typeof condition === "object" && !(condition instanceof Date)) {
            if ("in" in condition) return condition.in.includes(value);
            if ("equals" in condition) return condition.mode === "insensitive" ? String(value).toLowerCase() === String(condition.equals).toLowerCase() : value === condition.equals;
            if ("contains" in condition) return value != null && String(value).toLowerCase().includes(String(condition.contains).toLowerCase());
            if ("endsWith" in condition) return value != null && String(value).endsWith(condition.endsWith);
        }
        return value === condition;
    });
    const withRelations = (user) => ({
        ...user,
        stages: state.stages.filter((s) => s.passportId === user.passportId),
        documents: state.documents.filter((d) => d.passportId === user.passportId),
    });

    const db = {
        state,
        user: {
            findUnique: async ({ where }) => {
                const user = state.users.find((u) => matches(u, where));
                return user ? withRelations(user) : null;
            },
            findFirst: async ({ where }) => state.users.find((u) => matches(u, where)) ?? null,
            findMany: async ({ where = {}, skip = 0, take } = {}) => {
                const rows = state.users.filter((u) => matches(u, where)).map(withRelations);
                return take === undefined ? rows : rows.slice(skip, skip + take);
            },
            count: async ({ where = {} } = {}) => state.users.filter((u) => matches(u, where)).length,
            create: async ({ data }) => {
                if (state.users.some((u) => u.passportId === data.passportId)) throw unique("P2002", ["passport_id"]);
                if (state.users.some((u) => u.uniqueId === data.uniqueId)) throw unique("P2002", ["unique_id"]);
                if (data.nic && state.users.some((u) => u.nic === data.nic)) throw unique("P2002", ["nic"]);
                const row = { createdDate: new Date(), ...data };
                state.users.push(row);
                return row;
            },
            update: async ({ where, data }) => {
                const user = state.users.find((u) => matches(u, where));
                Object.assign(user, data);
                return user;
            },
        },
        candidateStage: {
            create: async ({ data }) => {
                state.stages.push({ completed: false, completedAt: null, notes: null, ...data });
            },
            upsert: async ({ where, create, update }) => {
                const { passportId, stage } = where.passportId_stage;
                const existing = state.stages.find((s) => s.passportId === passportId && s.stage === stage);
                if (existing) Object.assign(existing, update);
                else state.stages.push({ completedAt: null, notes: null, ...create });
            },
        },
        document: {
            findFirst: async ({ where }) => state.documents.find((d) => matches(d, where)) ?? null,
            findMany: async ({ where }) => state.documents.filter((d) => matches(d, where)),
            count: async ({ where }) => state.documents.filter((d) => matches(d, where)).length,
            updateMany: async ({ where, data }) => {
                const rows = state.documents.filter((d) => matches(d, where));
                rows.forEach((d) => Object.assign(d, data));
                return { count: rows.length };
            },
            create: async ({ data }) => {
                state.documents.push({ createdDate: new Date(), ...data });
            },
        },
        auditLog: { create: async ({ data }) => { state.auditLogs.push(data); } },
        candidateCallLog: {
            create: async ({ data }) => { state.callLogs.push({ createdDate: new Date(), ...data }); },
            findMany: async ({ where }) => state.callLogs
                .filter((c) => matches(c, where))
                .map((c) => ({ ...c, admin: state.admins.find((a) => a.adminId === c.adminId) ?? null })),
        },
        $transaction: async (fn) => fn(db),
    };
    return db;
}

function createFakeBucket() {
    const objects = new Map();
    return {
        objects,
        upload: async (path, buffer) => {
            if (objects.has(path)) return { error: { statusCode: "409", message: "The resource already exists" } };
            objects.set(path, buffer);
            return { error: null };
        },
        remove: async (paths) => {
            paths.forEach((p) => objects.delete(p));
            return { error: null };
        },
    };
}

const registered = async (db, overrides = {}) => {
    const parsed = parseCandidateBody({ ...VALID_BODY, ...overrides }, { creating: true });
    assert.ok(parsed.values, JSON.stringify(parsed.errors));
    return createCandidate({ db, values: parsed.values });
};

describe("candidate details validation", () => {
    test("registration normalizes the passport ID and NIC and keeps every job type", () => {
        const { values } = parseCandidateBody(VALID_BODY, { creating: true });
        assert.equal(values.passportId, "N1023757");
        assert.equal(values.nic, "965404378V");
        assert.equal(values.otherName, "De Soysa", "surname is the legacy OTHER NAME column");
        assert.equal(values.firstName, "Anusha", "other names are the legacy FIRST NAME column");
        assert.equal(values.job, "Construction Worker, Caregiver, Electrician");
        assert.equal(values.comment, "Prefers morning calls");
    });

    test("required fields, NIC format, job types and dates are checked", () => {
        const { errors } = parseCandidateBody({ passportId: "x", nic: "123", jobTypes: [], dateOfBirth: "2026-02-30" }, { creating: true });
        const fields = errors.map((e) => e.field);
        for (const field of ["passportId", "surname", "otherNames", "address", "jobExperience", "nic", "jobTypes", "dateOfBirth"]) {
            assert.ok(fields.includes(field), `${field} reported`);
        }
        assert.ok(parseCandidateBody({ ...VALID_BODY, jobTypes: ["A, B"] }, { creating: true }).errors);
    });

    test("updating never takes a new passport ID or a comment", () => {
        const { values } = parseCandidateBody(VALID_BODY, { creating: false });
        assert.equal(values.passportId, undefined);
        assert.equal(values.comment, undefined);
    });

    test("job types round-trip, and a legacy single value reads as one type", () => {
        assert.deepEqual(parseJobTypes("Caregiver"), ["Caregiver"]);
        assert.deepEqual(parseJobTypes(formatJobTypes(["Electrician", "Caregiver"])), ["Electrician", "Caregiver"]);
        assert.deepEqual(parseJobTypes(null), []);
    });
});

describe("registration", () => {
    test("creates the candidate in users with the next unique ID; the comment is the Candidate Details note", async () => {
        const db = createFakeDb({ users: [{ passportId: "P1111111", uniqueId: "0007", firstName: "A" }] });
        const result = await registered(db);
        assert.deepEqual(result, { passportId: "N1023757", uniqueId: "0008" });
        const user = db.state.users.find((u) => u.passportId === "N1023757");
        assert.equal(user.nic, "965404378V");
        assert.deepEqual(db.state.stages, [{ passportId: "N1023757", stage: "CANDIDATE_DETAILS", notes: "Prefers morning calls", completed: false, completedAt: null }]);
    });

    test("an existing passport ID (any case) is never registered again", async () => {
        const db = createFakeDb({ users: [{ passportId: "n1023757", uniqueId: "0001", firstName: "Legacy" }] });
        await assert.rejects(registered(db), (error) => error instanceof CandidateError && error.code === "CANDIDATE_EXISTS" && error.passportId === "n1023757");
        assert.equal(db.state.users.length, 1);
    });

    test("an NIC already registered to someone else is refused", async () => {
        const db = createFakeDb({ users: [{ passportId: "P2222222", uniqueId: "0001", firstName: "B", nic: "965404378V" }] });
        await assert.rejects(registered(db), (error) => error.code === "NIC_EXISTS");
    });
});

describe("optional passport and contact details", () => {
    const REQUIRED_ONLY = Object.freeze({
        passportId: "N1023757", surname: "De Soysa", otherNames: "Anusha", nic: "965404378V",
        address: "Negombo", jobTypes: ["Caregiver"], jobExperience: "2 years",
    });
    const OPTIONAL_FIELDS = ["nationality", "sex", "dateOfBirth", "placeOfBirth", "passportIssueDate", "passportExpiryDate", "whatsappNumber", "contactNumber"];

    test("registration succeeds with every optional field empty or missing; they are stored as NULL", async () => {
        const db = createFakeDb();
        const empty = Object.fromEntries(OPTIONAL_FIELDS.map((field) => [field, ""]));
        for (const body of [REQUIRED_ONLY, { ...REQUIRED_ONLY, ...empty }]) {
            const parsed = parseCandidateBody(body, { creating: true });
            assert.equal(parsed.errors, undefined, JSON.stringify(parsed.errors));
            for (const column of ["nationality", "sex", "dateOfBirth", "placeOfBirth", "passportIssueDate", "passportExpiryDate", "whatsappNumber", "contactNumber"]) {
                assert.equal(parsed.values[column], null, `${column} is NULL`);
            }
        }
        await createCandidate({ db, values: parseCandidateBody(REQUIRED_ONLY, { creating: true }).values });
        const { candidate } = await getCandidate({ db, passportId: "N1023757" });
        for (const field of OPTIONAL_FIELDS) assert.equal(candidate[field], null, `${field} reads as null`);
    });

    test("the required fields are unchanged", () => {
        for (const field of ["passportId", "surname", "otherNames", "nic", "address", "jobTypes", "jobExperience"]) {
            const body = { ...REQUIRED_ONLY };
            delete body[field];
            const { errors } = parseCandidateBody(body, { creating: true });
            assert.deepEqual(errors?.map((e) => e.field), [field], `${field} still required`);
        }
    });

    test("values are normalized: sex upper case, phone numbers in the WhatsApp sender format", () => {
        const { values } = parseCandidateBody({
            ...REQUIRED_ONLY, nationality: " Sri Lankan ", sex: "f", passportIssueDate: "2021-05-12", passportExpiryDate: "2031-05-11",
            whatsappNumber: "077 123 4567", contactNumber: "+94 11 234 5678",
        }, { creating: true });
        assert.equal(values.nationality, "Sri Lankan");
        assert.equal(values.sex, "F");
        assert.equal(values.passportIssueDate.toISOString().slice(0, 10), "2021-05-12");
        assert.equal(values.whatsappNumber, "94771234567");
        assert.equal(values.contactNumber, "94112345678");
    });

    test("an optional value that is given must be valid", () => {
        const fields = (body) => parseCandidateBody({ ...REQUIRED_ONLY, ...body }, { creating: true }).errors?.map((e) => e.field);
        assert.deepEqual(fields({ sex: "Q" }), ["sex"]);
        assert.deepEqual(fields({ passportIssueDate: "2031-05-12", passportExpiryDate: "2031-05-11" }), ["passportIssueDate"]);
        assert.deepEqual(fields({ passportIssueDate: "12/05/2021" }), ["passportIssueDate"]);
        assert.deepEqual(fields({ whatsappNumber: "12" }), ["whatsappNumber"]);
        assert.deepEqual(fields({ contactNumber: "call me" }), ["contactNumber"]);
    });

    test("a WhatsApp number already on another record is refused (it would make document matching ambiguous)", async () => {
        const db = createFakeDb({ users: [{ passportId: "P2222222", uniqueId: "0001", firstName: "B", whatsappNumber: "+94 77 123 4567" }] });
        const values = parseCandidateBody({ ...REQUIRED_ONLY, whatsappNumber: "0771234567" }, { creating: true }).values;
        await assert.rejects(createCandidate({ db, values }), (error) => error.code === "WHATSAPP_EXISTS");
        assert.equal(db.state.users.length, 1);
    });

    test("a missing WhatsApp number can be added, and is still refused when another record already has it", async () => {
        const db = createFakeDb({ users: [
            { passportId: "P3333333", uniqueId: "0001", firstName: "Legacy", whatsappNumber: "94770000001" },
            { passportId: "P4444444", uniqueId: "0002", firstName: "NoPhone" },
        ] });
        const update = (passportId, body) => updateCandidateDetails({ db, passportId, values: parseCandidateBody({ ...REQUIRED_ONLY, ...body }, { creating: false }).values });

        await assert.rejects(update("P4444444", { nic: "200012345679", whatsappNumber: "0770000001" }), (error) => error.code === "WHATSAPP_EXISTS", "another record's number");
        const added = await update("P4444444", { nic: "200012345679", whatsappNumber: "0779999999", sex: "M", nationality: "Sri Lankan" });
        assert.equal(added.candidate.whatsappNumber, "94779999999");
        assert.equal(added.candidate.sex, "M");
    });

    // L2: an existing WhatsApp number is locked (the admin's form shows it
    // read-only), so it is never silently changed. The same number comes
    // back unchanged whatever form it is resubmitted in (case C); leaving it
    // out is the same as resubmitting it (also not a change); a genuinely
    // different number is refused outright, never silently kept (case D).
    describe("an existing WhatsApp number is locked, not silently kept", () => {
        const update = (db, passportId, body) => updateCandidateDetails({ db, passportId, values: parseCandidateBody({ ...REQUIRED_ONLY, ...body }, { creating: false }).values });

        test("resubmitting the exact same number (already normalized on record) succeeds unchanged", async () => {
            const db = createFakeDb({ users: [{ passportId: "P3333333", uniqueId: "0001", firstName: "Legacy", whatsappNumber: "94770000001" }] });
            const result = await update(db, "P3333333", { nic: "200012345678", whatsappNumber: "0770000001" });
            assert.equal(result.candidate.whatsappNumber, "94770000001");
        });

        test("resubmitting the same number in a differently formatted (unnormalized) stored record succeeds unchanged", async () => {
            // A legacy/manually entered row, stored with a leading "+" rather
            // than the normalized sender format: the comparison still
            // recognizes it as the same number, not a change.
            const db = createFakeDb({ users: [{ passportId: "P6666666", uniqueId: "0006", firstName: "Legacy", whatsappNumber: "+94771581916" }] });
            const result = await update(db, "P6666666", { nic: "200012345680", whatsappNumber: "0771581916" });
            assert.equal(result.candidate.whatsappNumber, "+94771581916", "the stored value is untouched");
        });

        test("leaving the field out (or empty) is not an attempted change and is accepted", async () => {
            const db = createFakeDb({ users: [{ passportId: "P3333333", uniqueId: "0001", firstName: "Legacy", whatsappNumber: "94770000001" }] });
            const result = await update(db, "P3333333", { nic: "200012345678", whatsappNumber: "" });
            assert.equal(result.candidate.whatsappNumber, "94770000001", "unchanged, not cleared");
        });

        test("a genuinely different number is refused outright, not silently kept", async () => {
            const db = createFakeDb({ users: [{ passportId: "P3333333", uniqueId: "0001", firstName: "Legacy", whatsappNumber: "94770000001" }] });
            await assert.rejects(
                update(db, "P3333333", { nic: "200012345678", whatsappNumber: "0779999999" }),
                (error) => error.code === "WHATSAPP_LOCKED" && error.status === 409,
            );
            // Refused before anything else in the request is written.
            assert.equal(db.state.users[0].whatsappNumber, "94770000001");
            assert.equal(db.state.users[0].nic, undefined, "no partial update either");
        });
    });

    test("an existing record without any of the new details still reads correctly", async () => {
        const db = createFakeDb({ users: [{ passportId: "P5555555", uniqueId: "0003", firstName: "Old", otherName: null, job: null }] });
        const { candidate } = await getCandidate({ db, passportId: "P5555555" });
        assert.equal(candidate.nationality, null);
        assert.equal(candidate.sex, null);
        assert.equal(candidate.passportIssueDate, null);
        assert.equal(candidate.contactNumber, null);
        assert.deepEqual(candidate.jobTypes, []);
    });
});

describe("independent stages", () => {
    test("every stage can be completed in any order; completed stages are reported in display order", async () => {
        const db = createFakeDb();
        await registered(db);
        for (const stage of ["FINALIZING_JOB", "VISA_APPROVAL", "IVS_INTERVIEW"]) {
            await updateStage({ db, passportId: "N1023757", stage, values: { completed: true } });
        }
        const { stages } = await getCandidate({ db, passportId: "N1023757" });
        assert.deepEqual(stages.map((s) => s.stage), [...CANDIDATE_STAGES]);
        assert.deepEqual(stages.map((s) => s.completed), [false, false, false, true, true, true]);
    });

    test("Candidate Details and Document Submission complete automatically from the record; the list agrees", async () => {
        const db = createFakeDb();
        const bucket = createFakeBucket();
        await registered(db);
        const stageOf = (result, stage) => result.stages.find((s) => s.stage === stage);
        const listed = async () => (await listCandidates({ db, params: { page: 1, pageSize: 25 } })).items[0].stages.map((s) => s.completed);

        let result = await getCandidate({ db, passportId: "N1023757" });
        assert.equal(stageOf(result, "CANDIDATE_DETAILS").automatic, true);
        assert.equal(stageOf(result, "CANDIDATE_DETAILS").completed, false);
        assert.deepEqual(stageOf(result, "CANDIDATE_DETAILS").missing, ["passport document"]);
        assert.deepEqual(stageOf(result, "DOCUMENT_SUBMISSION").missing, ["passport", "medical", "police report", "agreement", "affidavit"]);
        assert.equal(stageOf(result, "TEST_DETAILS").automatic, false);

        // The passport completes Candidate Details: no checkbox needed.
        result = await uploadCandidateDocument({ db, bucket, admin: ADMIN, passportId: "N1023757", documentType: "PASSPORT", variant: null, mimeType: "application/pdf", buffer: PDF });
        assert.equal(stageOf(result, "CANDIDATE_DETAILS").completed, true);
        assert.deepEqual(stageOf(result, "CANDIDATE_DETAILS").missing, []);
        assert.deepEqual(await listed(), [false, true, false, false, false, false]);

        const uploads = [["MEDICAL", null], ["POLICE_REPORT", "SL_VERIFIED"], ["AGREEMENT", null], ["AFFIDAVIT", "SINHALA"]];
        for (const [index, [documentType, variant]] of uploads.entries()) {
            const buffer = Buffer.concat([PDF, Buffer.from([index])]);
            result = await uploadCandidateDocument({ db, bucket, admin: ADMIN, passportId: "N1023757", documentType, variant, mimeType: "application/pdf", buffer });
        }
        assert.equal(stageOf(result, "DOCUMENT_SUBMISSION").completed, true);
        assert.deepEqual(await listed(), [false, true, true, false, false, false]);
        assert.deepEqual(result.requiredDocuments.map((r) => r.documentType), [...REQUIRED_SUBMISSION_DOCUMENTS]);
        assert.equal(result.documents.AFFIDAVIT.variant, "SINHALA");

        // Notes can still be saved; completion can't be set by hand.
        result = await updateStage({ db, passportId: "N1023757", stage: "DOCUMENT_SUBMISSION", values: { notes: "All checked" } });
        assert.equal(stageOf(result, "DOCUMENT_SUBMISSION").notes, "All checked");
        await assert.rejects(updateStage({ db, passportId: "N1023757", stage: "CANDIDATE_DETAILS", values: { completed: false } }), (error) => error.code === "AUTOMATIC_STAGE");
    });

    test("a document received on WhatsApp counts; clearing a required detail un-completes the stage", async () => {
        const db = createFakeDb({ documents: [{ documentId: "d1", passportId: "N1023757", documentType: "PASSPORT", verificationStatus: "REVIEW_REQUIRED", receivedDate: new Date(), createdDate: new Date() }] });
        await registered(db);
        const stage = async () => (await getCandidate({ db, passportId: "N1023757" })).stages.find((s) => s.stage === "CANDIDATE_DETAILS");
        assert.equal((await stage()).completed, true);
        db.state.users[0].jobExperience = null;
        assert.equal((await stage()).completed, false);
        assert.deepEqual((await stage()).missing, ["job experience"]);
        db.state.documents[0].verificationStatus = "SUPERSEDED";
        assert.deepEqual((await stage()).missing, ["job experience", "passport document"]);
    });

    test("un-completing a stage clears its completion time; notes alone are saved without completing", async () => {
        const db = createFakeDb();
        await registered(db);
        await updateStage({ db, passportId: "N1023757", stage: "TEST_DETAILS", values: { completed: true } });
        let stage = (await updateStage({ db, passportId: "N1023757", stage: "TEST_DETAILS", values: { completed: false } })).stages[0];
        assert.equal(stage.completed, false);
        assert.equal(stage.completedAt, null);
        stage = (await updateStage({ db, passportId: "N1023757", stage: "TEST_DETAILS", values: { notes: "Trade test booked" } })).stages[0];
        assert.equal(stage.completed, false);
        assert.equal(stage.notes, "Trade test booked");
    });

    test("stage body validation", () => {
        assert.ok(parseStageBody({}).errors);
        assert.ok(parseStageBody({ completed: "yes" }).errors);
        assert.deepEqual(parseStageBody({ completed: true, notes: "  x  " }).values, { completed: true, notes: "x" });
    });
});

describe("candidate details stage", () => {
    test("updates the existing record; another candidate's NIC is refused", async () => {
        const db = createFakeDb({ users: [{ passportId: "P2222222", uniqueId: "0001", firstName: "B", nic: "200012345678" }] });
        await registered(db);
        const { values } = parseCandidateBody({ ...VALID_BODY, address: "Colombo" }, { creating: false });
        const result = await updateCandidateDetails({ db, passportId: "N1023757", values });
        assert.equal(result.candidate.address, "Colombo");
        const taken = parseCandidateBody({ ...VALID_BODY, nic: "200012345678" }, { creating: false }).values;
        await assert.rejects(updateCandidateDetails({ db, passportId: "N1023757", values: taken }), (error) => error.code === "NIC_EXISTS");
    });
});

describe("document uploads", () => {
    test("type and variant rules", () => {
        assert.deepEqual(parseUploadQuery({ type: "POLICE_REPORT", variant: "ROMANIA" }).values, { documentType: "POLICE_REPORT", variant: "ROMANIA" });
        assert.ok(parseUploadQuery({ type: "POLICE_REPORT" }).errors, "variant required");
        assert.ok(parseUploadQuery({ type: "AFFIDAVIT", variant: "TAMIL" }).errors);
        assert.ok(parseUploadQuery({ type: "MEDICAL", variant: "ENGLISH" }).errors, "no variant for medical");
        assert.ok(parseUploadQuery({ type: "UNKNOWN_DOC" }).errors, "only candidate document types");
    });

    test("file checks: documents are PDF/JPG/PNG; only the skill video may be a video, with a real video header", () => {
        assert.equal(validateCandidateUpload({ documentType: "PASSPORT", mimeType: "application/pdf", buffer: PDF }), null);
        assert.equal(validateCandidateUpload({ documentType: "NIC", mimeType: "image/png", buffer: PNG }), null);
        assert.match(validateCandidateUpload({ documentType: "PASSPORT", mimeType: "image/png", buffer: PDF }), /does not match/);
        assert.match(validateCandidateUpload({ documentType: "PASSPORT", mimeType: "video/mp4", buffer: MP4 }), /not accepted/);
        assert.equal(validateCandidateUpload({ documentType: "SKILL_VIDEO", mimeType: "video/mp4", buffer: MP4 }), null);
        assert.match(validateCandidateUpload({ documentType: "SKILL_VIDEO", mimeType: "video/mp4", buffer: PDF }), /does not match/);
    });

    test("the skill video takes MP4, MOV and WebM only; a PDF or an image is refused", () => {
        const skill = (mimeType, buffer) => validateCandidateUpload({ documentType: "SKILL_VIDEO", mimeType, buffer });
        assert.equal(skill("video/mp4", MP4), null);
        assert.equal(skill("video/quicktime", MOV), null);
        assert.equal(skill("video/webm", WEBM), null);

        // Real documents, honestly labelled: valid for every other type, not for the skill video.
        for (const [mimeType, buffer] of [["application/pdf", PDF], ["image/jpeg", JPEG], ["image/png", PNG]]) {
            assert.match(skill(mimeType, buffer), /Use MP4, MOV or WebM/, `${mimeType} refused`);
            assert.equal(validateCandidateUpload({ documentType: "MEDICAL", mimeType, buffer }), null, `${mimeType} still fine for a document`);
        }
        assert.match(skill("video/x-matroska", MP4), /Use MP4, MOV or WebM/);
        assert.match(skill(undefined, MP4), /no type/);

        // Video types whose content isn't that video stay refused.
        assert.match(skill("video/webm", MP4), /does not match/);
        assert.match(skill("video/quicktime", PNG), /does not match/);
        assert.match(skill("video/mp4", Buffer.alloc(0)), /empty/);
    });

    test("an upload of a PDF as the skill video stores nothing", async () => {
        const db = createFakeDb();
        const bucket = createFakeBucket();
        await registered(db);
        await assert.rejects(
            uploadCandidateDocument({ db, bucket, admin: ADMIN, passportId: "N1023757", documentType: "SKILL_VIDEO", variant: null, mimeType: "application/pdf", buffer: PDF }),
            (error) => error.status === 422 && error.code === "FILE_REJECTED",
        );
        assert.equal(bucket.objects.size, 0);
        assert.equal(db.state.documents.length, 0);
    });

    test("an upload becomes the current document; the previous one is superseded, never deleted; each upload is audited", async () => {
        const db = createFakeDb();
        const bucket = createFakeBucket();
        await registered(db);
        const upload = (buffer) => uploadCandidateDocument({ db, bucket, admin: ADMIN, passportId: "N1023757", documentType: "MEDICAL", variant: null, mimeType: "application/pdf", buffer, originalFileName: "medical report.pdf" });
        await upload(PDF);
        await upload(Buffer.concat([PDF, Buffer.from("v2")]));

        assert.deepEqual([...bucket.objects.keys()], ["clients/N1023757/medical/medical.pdf", "clients/N1023757/medical/medical_v2.pdf"]);
        assert.deepEqual(db.state.documents.map((d) => d.verificationStatus), ["SUPERSEDED", "VERIFIED"]);
        assert.deepEqual(db.state.auditLogs.map((a) => [a.action, a.previousStatus, a.newStatus]), [["UPLOAD_DOCUMENT", "NONE", "VERIFIED"], ["UPLOAD_DOCUMENT", "VERIFIED", "VERIFIED"]]);
        assert.equal((await getCandidate({ db, passportId: "N1023757" })).documents.MEDICAL.originalFilename, "medical report.pdf");
    });

    test("the same file twice is refused and nothing new is stored", async () => {
        const db = createFakeDb();
        const bucket = createFakeBucket();
        await registered(db);
        const upload = () => uploadCandidateDocument({ db, bucket, admin: ADMIN, passportId: "N1023757", documentType: "NIC", variant: null, mimeType: "application/pdf", buffer: PDF });
        await upload();
        await assert.rejects(upload(), (error) => error.code === "DUPLICATE_FILE");
        assert.equal(bucket.objects.size, 1);
        assert.equal(db.state.documents.length, 1);
    });

    test("a document record that can't be written removes the uploaded object again", async () => {
        const db = createFakeDb();
        const bucket = createFakeBucket();
        await registered(db);
        db.document.create = async () => { throw new Error("database down"); };
        await assert.rejects(uploadCandidateDocument({ db, bucket, admin: ADMIN, passportId: "N1023757", documentType: "AGREEMENT", variant: null, mimeType: "application/pdf", buffer: PDF }), /upload removed/);
        assert.equal(bucket.objects.size, 0);
    });

    test("the original file name is decoded, stripped of paths, and never trusted", () => {
        assert.equal(originalFileNameFrom(encodeURIComponent("C:\\scans\\passport copy.pdf"), null), "passport copy.pdf");
        assert.equal(originalFileNameFrom("%E0%A4%A", "fallback"), "fallback");
        assert.equal(originalFileNameFrom(undefined, null), null);
    });
});

describe("candidate list and call log", () => {
    test("lists candidates with NIC, job types and stage progress; NIC is searchable", async () => {
        const db = createFakeDb({ users: [{ passportId: "P2222222", uniqueId: "0001", firstName: "Kamal", otherName: "Perera", job: "Caregiver" }] });
        await registered(db);
        await updateStage({ db, passportId: "N1023757", stage: "VISA_APPROVAL", values: { completed: true } });

        const all = await listCandidates({ db, params: { page: 1, pageSize: 25 } });
        assert.equal(all.pagination.total, 2);
        const anusha = all.items.find((c) => c.passportId === "N1023757");
        assert.deepEqual(anusha.jobTypes, ["Construction Worker", "Caregiver", "Electrician"]);
        assert.equal(anusha.stages.length, 6);
        assert.equal(anusha.stages.find((s) => s.stage === "VISA_APPROVAL").completed, true);

        const byNic = await listCandidates({ db, params: { page: 1, pageSize: 25, search: "965404378" } });
        assert.deepEqual(byNic.items.map((c) => c.passportId), ["N1023757"]);
    });

    test("call notes are kept with the admin who wrote them", async () => {
        const db = createFakeDb();
        await registered(db);
        const { items } = await addCallLog({ db, admin: ADMIN, passportId: "N1023757", values: { note: "Called about medical" } });
        assert.deepEqual(items.map((i) => [i.note, i.adminName]), [["Called about medical", "Test Admin"]]);
    });
});

describe("candidate routes: roles", () => {
    // file: { mimeType, buffer } sends the raw file body (the upload route).
    async function call(role, method, path, body, db = createFakeDb(), { bucket = createFakeBucket(), file } = {}) {
        const app = express();
        app.use(express.json());
        const requireAdmin = (req, res, next) => { req.admin = { ...ADMIN, role }; next(); };
        app.use("/api/admin", createAdminRouter({ db, bucket, requireAdmin, apiLimiter: noRateLimit }));
        app.use(errorHandler);
        const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
        try {
            const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
                method,
                headers: { "content-type": file ? file.mimeType : "application/json" },
                body: file ? file.buffer : body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: await response.json() };
        } finally {
            server.close();
        }
    }

    test("a VIEWER can list candidates but not register, edit stages or add call notes", async () => {
        assert.equal((await call("VIEWER", "GET", "/api/admin/candidates")).status, 200);
        assert.equal((await call("VIEWER", "POST", "/api/admin/candidates", VALID_BODY)).status, 403);
        assert.equal((await call("VIEWER", "PUT", "/api/admin/candidates/N1023757/stages/TEST_DETAILS", { completed: true })).status, 403);
        assert.equal((await call("VIEWER", "POST", "/api/admin/candidates/N1023757/call-logs", { note: "x" })).status, 403);
    });

    test("a ANALYST can register a candidate; bad input and unknown stages are refused", async () => {
        const created = await call("ANALYST", "POST", "/api/admin/candidates", VALID_BODY);
        assert.equal(created.status, 201);
        assert.equal(created.body.passportId, "N1023757");
        assert.equal((await call("ANALYST", "POST", "/api/admin/candidates", { surname: "x" })).status, 400);
        assert.equal((await call("ADMIN", "PUT", "/api/admin/candidates/N1023757/stages/NOT_A_STAGE", { completed: true })).status, 404);
        assert.equal((await call("ADMIN", "GET", "/api/admin/candidates/N1023757")).status, 404, "this fake starts empty per request");
    });

    test("the registration lookup (GET by passport ID) finds a legacy lowercase record and returns its stored ID", async () => {
        const db = createFakeDb({ users: [{ passportId: "n1023757", uniqueId: "0001", firstName: "Anusha", otherName: "De Soysa" }] });
        const found = await call("VIEWER", "GET", "/api/admin/candidates/N1023757", undefined, db);
        assert.equal(found.status, 200);
        assert.equal(found.body.candidate.passportId, "n1023757");
        assert.equal(found.body.candidate.surname, "De Soysa");
        assert.equal((await call("VIEWER", "GET", "/api/admin/candidates/N9999999", undefined, db)).status, 404, "not found -> new registration");
    });

    // A legacy record stored in lowercase, reached with the uppercase ID:
    // every action works on that record, which keeps its stored ID.
    describe("a legacy lowercase passport ID, used in uppercase", () => {
        const LEGACY = { passportId: "n1023757", uniqueId: "0001", firstName: "Anusha", otherName: "De Soysa", nic: "965404378V", address: "Negombo", job: "Caregiver", jobExperience: "2 years" };
        const { passportId: _ignored, comment: _comment, ...DETAILS_BODY } = VALID_BODY;

        test("details, stages, documents and call notes all reach the stored record", async () => {
            const db = createFakeDb({ users: [LEGACY] });
            const bucket = createFakeBucket();

            const details = await call("ANALYST", "PUT", "/api/admin/candidates/N1023757", { ...DETAILS_BODY, address: "Kandy" }, db);
            assert.equal(details.status, 200);
            assert.equal(details.body.candidate.passportId, "n1023757");
            assert.equal(db.state.users[0].address, "Kandy");

            const stage = await call("ANALYST", "PUT", "/api/admin/candidates/N1023757/stages/TEST_DETAILS", { completed: true, notes: "Booked" }, db);
            assert.equal(stage.status, 200);
            assert.deepEqual(db.state.stages.map((s) => [s.passportId, s.stage, s.completed]), [["n1023757", "TEST_DETAILS", true]]);

            const upload = await call("ANALYST", "POST", "/api/admin/candidates/N1023757/documents?type=MEDICAL", undefined, db, { bucket, file: { mimeType: "application/pdf", buffer: PDF } });
            assert.equal(upload.status, 200);
            assert.equal(upload.body.documents.MEDICAL.verificationStatus, "VERIFIED");
            assert.deepEqual(db.state.documents.map((d) => d.passportId), ["n1023757"]);
            assert.deepEqual([...bucket.objects.keys()], ["clients/n1023757/medical/medical.pdf"]);

            assert.equal((await call("ANALYST", "POST", "/api/admin/candidates/N1023757/call-logs", { note: "Called" }, db)).status, 201);
            const logs = await call("VIEWER", "GET", "/api/admin/candidates/N1023757/call-logs", undefined, db);
            assert.equal(logs.status, 200);
            assert.deepEqual(logs.body.items.map((i) => i.note), ["Called"]);
            assert.deepEqual(db.state.callLogs.map((c) => c.passportId), ["n1023757"]);

            assert.equal(db.state.users.length, 1, "no second record");
            assert.equal(db.state.users[0].passportId, "n1023757", "stored ID unchanged");
        });

        test("two records differing only in case: every action is 404, nothing is written", async () => {
            const db = createFakeDb({ users: [{ ...LEGACY, passportId: "na444444", nic: null }, { ...LEGACY, passportId: "Na444444", uniqueId: "0002", nic: null }] });
            const bucket = createFakeBucket();
            const requests = [
                ["PUT", "/api/admin/candidates/NA444444", DETAILS_BODY],
                ["PUT", "/api/admin/candidates/NA444444/stages/TEST_DETAILS", { completed: true }],
                ["POST", "/api/admin/candidates/NA444444/call-logs", { note: "x" }],
                ["GET", "/api/admin/candidates/NA444444/call-logs", undefined],
            ];
            for (const [method, path, body] of requests) {
                const response = await call("ADMIN", method, path, body, db);
                assert.equal(response.status, 404, `${method} ${path}`);
                assert.equal(response.body.code, "NOT_FOUND");
            }
            const upload = await call("ADMIN", "POST", "/api/admin/candidates/NA444444/documents?type=MEDICAL", undefined, db, { bucket, file: { mimeType: "application/pdf", buffer: PDF } });
            assert.equal(upload.status, 404);
            assert.equal(bucket.objects.size, 0);
            assert.equal(db.state.stages.length + db.state.callLogs.length + db.state.documents.length, 0);
        });

        test("roles are unchanged: a VIEWER still can't change the record", async () => {
            const db = createFakeDb({ users: [LEGACY] });
            assert.equal((await call("VIEWER", "PUT", "/api/admin/candidates/N1023757", DETAILS_BODY, db)).status, 403);
            assert.equal((await call("VIEWER", "PUT", "/api/admin/candidates/N1023757/stages/TEST_DETAILS", { completed: true }, db)).status, 403);
            assert.equal((await call("VIEWER", "POST", "/api/admin/candidates/N1023757/documents?type=MEDICAL", undefined, db, { file: { mimeType: "application/pdf", buffer: PDF } })).status, 403);
            assert.equal((await call("VIEWER", "POST", "/api/admin/candidates/N1023757/call-logs", { note: "x" }, db)).status, 403);
            assert.equal(db.state.users[0].address, "Negombo");
        });
    });
});

describe("registration lookup of an existing passport ID", () => {
    test("exact, then case-insensitive; never a guess between two rows", async () => {
        const db = createFakeDb({ users: [
            { passportId: "N1111111", uniqueId: "0001", firstName: "A" },
            { passportId: "n2222222", uniqueId: "0002", firstName: "B" },
            { passportId: "n3333333", uniqueId: "0003", firstName: "C" },
            { passportId: "N3333333", uniqueId: "0004", firstName: "D" },
            { passportId: "na444444", uniqueId: "0005", firstName: "E" },
            { passportId: "Na444444", uniqueId: "0006", firstName: "F" },
        ] });
        assert.equal(await resolveCandidatePassportId({ db, passportId: "N1111111" }), "N1111111");
        assert.equal(await resolveCandidatePassportId({ db, passportId: "N2222222" }), "n2222222");
        assert.equal(await resolveCandidatePassportId({ db, passportId: "N3333333" }), "N3333333", "exact match wins");
        assert.equal(await resolveCandidatePassportId({ db, passportId: "NA444444" }), null, "two rows differ only in case: no guess");
        assert.equal(await resolveCandidatePassportId({ db, passportId: "N5555555" }), null);
    });

    test("the lookup returns the stored details, documents and stages; saving updates that record only", async () => {
        const db = createFakeDb();
        const bucket = createFakeBucket();
        await registered(db, { nationality: "Sri Lankan", sex: "F", whatsappNumber: "0771234567" });
        await uploadCandidateDocument({ db, bucket, admin: ADMIN, passportId: "N1023757", documentType: "PASSPORT", variant: null, mimeType: "application/pdf", buffer: PDF, originalFileName: "passport.pdf" });
        await updateStage({ db, passportId: "N1023757", stage: "IVS_INTERVIEW", values: { completed: true, notes: "Passed" } });

        const loaded = await getCandidate({ db, passportId: await resolveCandidatePassportId({ db, passportId: "N1023757" }) });
        assert.equal(loaded.candidate.nationality, "Sri Lankan");
        assert.equal(loaded.candidate.whatsappNumber, "94771234567");
        assert.equal(loaded.documents.PASSPORT.originalFilename, "passport.pdf", "existing document returned");
        assert.equal(loaded.documents.NIC, null, "missing document stays uploadable");
        assert.equal(loaded.documents.SKILL_VIDEO, null);

        const before = { users: db.state.users.length, documents: db.state.documents.length, objects: bucket.objects.size, stages: structuredClone(db.state.stages) };
        const { values } = parseCandidateBody({ ...VALID_BODY, address: "Kandy", nationality: "Sri Lankan", sex: "F" }, { creating: false });
        const saved = await updateCandidateDetails({ db, passportId: "N1023757", values });

        assert.equal(saved.candidate.address, "Kandy", "the existing users row is updated");
        assert.equal(db.state.users.length, before.users, "no duplicate user");
        assert.equal(db.state.documents.length, before.documents, "no duplicate document");
        assert.equal(bucket.objects.size, before.objects, "no file copied");
        assert.deepEqual(db.state.stages, before.stages, "stage progress preserved");
        assert.equal(saved.stages.find((s) => s.stage === "IVS_INTERVIEW").completed, true);
        assert.equal(saved.documents.PASSPORT.documentId, loaded.documents.PASSPORT.documentId, "same document reference");
    });
});
