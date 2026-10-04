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
    cleanOriginalFileName,
    checkDeclaredFile,
    createUploadTarget,
    finalizeUpload,
    parseFinalizeUploadBody,
    parseRemoveDocumentBody,
    removeCandidateDocument,
    parseUploadTargetBody,
    STAGED_UPLOAD_MAX_AGE_MS,
    parseCallLogBody,
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
            if ("not" in condition) return value !== condition.not;
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
            deleteMany: async ({ where }) => {
                const before = state.documents.length;
                state.documents = state.documents.filter((d) => !matches(d, where));
                return { count: before - state.documents.length };
            },
        },
        auditLog: { create: async ({ data }) => { state.auditLogs.push(data); } },
        candidateCallLog: {
            create: async ({ data }) => { state.callLogs.push({ createdDate: new Date(), ...data }); },
            // Newest call first, like orderBy createdDate desc.
            findMany: async ({ where }) => state.callLogs
                .filter((c) => matches(c, where))
                .sort((a, b) => b.createdDate - a.createdDate)
                .map((c) => ({ ...c, admin: state.admins.find((a) => a.adminId === c.adminId) ?? null })),
        },
        $transaction: async (fn) => fn(db),
    };
    return db;
}

// Supabase Storage, as candidateService.js uses it. objects: path -> bytes.
// signedUploads: the paths a signed upload URL was issued for; browserPut
// stands in for the browser's PUT to that URL (only an issued path, never
// over an existing object, like the real signed upload).
function createFakeBucket() {
    const objects = new Map();
    const meta = new Map();
    const signedUploads = [];
    const notFound = () => ({ statusCode: "404", message: "Object not found" });
    const store = (path, buffer, contentType, createdAt = new Date()) => {
        objects.set(path, buffer);
        meta.set(path, { contentType, createdAt });
    };
    const bucket = {
        objects,
        signedUploads,
        upload: async (path, buffer, { contentType } = {}) => {
            if (objects.has(path)) return { error: { statusCode: "409", message: "The resource already exists" } };
            store(path, buffer, contentType);
            return { error: null };
        },
        remove: async (paths) => {
            paths.forEach((p) => { objects.delete(p); meta.delete(p); });
            return { error: null };
        },
        createSignedUploadUrl: async (path) => {
            signedUploads.push(path);
            return { data: { signedUrl: `https://project.supabase.co/storage/v1/object/upload/sign/documents/${path}?token=signed-${signedUploads.length}`, token: `signed-${signedUploads.length}`, path }, error: null };
        },
        browserPut: (path, buffer, contentType, createdAt) => {
            if (!signedUploads.includes(path)) throw new Error(`no signed upload URL for ${path}`);
            if (objects.has(path)) throw new Error("signed upload refused: object exists");
            store(path, buffer, contentType, createdAt);
        },
        info: async (path) => (objects.has(path)
            ? { data: { name: path.split("/").pop(), size: objects.get(path).length, contentType: meta.get(path).contentType }, error: null }
            : { data: null, error: notFound() }),
        exists: async (path) => (objects.has(path) ? { data: true, error: null } : { data: false, error: notFound() }),
        download: async (path) => (objects.has(path) ? { data: objects.get(path), error: null } : { data: null, error: notFound() }),
        move: async (from, to) => {
            if (!objects.has(from)) return { data: null, error: notFound() };
            if (objects.has(to)) return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
            store(to, objects.get(from), meta.get(from).contentType, meta.get(from).createdAt);
            objects.delete(from);
            meta.delete(from);
            return { data: { message: "Successfully moved" }, error: null };
        },
        list: async (folder) => ({
            data: [...objects.keys()]
                .filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/"))
                .map((p) => ({ name: p.slice(folder.length + 1), created_at: meta.get(p).createdAt.toISOString() })),
            error: null,
        }),
    };
    return bucket;
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
        assert.deepEqual(stageOf(result, "DOCUMENT_SUBMISSION").missing, ["medical", "sl verified police report", "romania police report", "scans"]);
        assert.equal(stageOf(result, "TEST_DETAILS").automatic, false);

        // The passport completes Candidate Details: no checkbox needed.
        result = await uploadCandidateDocument({ db, bucket, admin: ADMIN, passportId: "N1023757", documentType: "PASSPORT", variant: null, mimeType: "application/pdf", buffer: PDF });
        assert.equal(stageOf(result, "CANDIDATE_DETAILS").completed, true);
        assert.deepEqual(stageOf(result, "CANDIDATE_DETAILS").missing, []);
        assert.deepEqual(await listed(), [false, true, false, false, false, false]);

        const uploads = [["MEDICAL", null], ["POLICE_REPORT", "SL_VERIFIED"], ["POLICE_REPORT", "ROMANIA"], ["AGREEMENT", null], ["AFFIDAVIT", "SINHALA"]];
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

    describe("Test details: result and date", () => {
        test("a job ID, PASS or FAIL and a real date, Test details only; null clears; a field left out is unchanged", () => {
            const { values } = parseStageBody({ jobId: "  JOB-2026-014 ", testResult: "PASS", testDate: "2026-09-28" }, "TEST_DETAILS");
            assert.equal(values.jobId, "JOB-2026-014");
            assert.equal(values.testResult, "PASS");
            assert.equal(values.testDate.toISOString().slice(0, 10), "2026-09-28");
            assert.deepEqual(parseStageBody({ jobId: null, testResult: null, testDate: null }, "TEST_DETAILS").values, { jobId: null, testResult: null, testDate: null });
            assert.deepEqual(parseStageBody({ jobId: "" }, "TEST_DETAILS").values, { jobId: null }, "empty text clears it");
            assert.deepEqual(parseStageBody({ notes: "x" }, "TEST_DETAILS").values, { notes: "x" }, "no result is invented");

            const fields = (body, stage = "TEST_DETAILS") => parseStageBody(body, stage).errors?.map((e) => e.field);
            assert.deepEqual(fields({ testResult: "pass" }), ["testResult"]);
            assert.deepEqual(fields({ testResult: "MAYBE" }), ["testResult"]);
            assert.deepEqual(fields({ testDate: "2026-02-30" }), ["testDate"]);
            assert.deepEqual(fields({ testDate: "28/09/2026" }), ["testDate"]);
            assert.deepEqual(fields({ jobId: "x".repeat(51) }), ["jobId"]);
            assert.deepEqual(fields({ jobId: 14 }), ["jobId"]);
            assert.deepEqual(fields({ jobId: "JOB-1" }, "FINALIZING_JOB"), ["jobId"]);
            assert.deepEqual(fields({ testResult: "PASS" }, "IVS_INTERVIEW"), ["testResult"]);
            assert.deepEqual(fields({ testDate: "2026-09-28" }, "VISA_APPROVAL"), ["testDate"]);
        });

        test("saved and read back with the notes and completion; other stages are untouched", async () => {
            const db = createFakeDb();
            await registered(db);
            const save = (body) => updateStage({ db, passportId: "N1023757", stage: "TEST_DETAILS", values: parseStageBody(body, "TEST_DETAILS").values });

            let stage = (await save({ notes: "Trade test", completed: true, jobId: "JOB-2026-014", testResult: "FAIL", testDate: "2026-09-28" })).stages[0];
            assert.deepEqual([stage.stage, stage.jobId, stage.testResult, stage.testDate, stage.notes, stage.completed], ["TEST_DETAILS", "JOB-2026-014", "FAIL", "2026-09-28", "Trade test", true]);

            // Saving only the result keeps the saved job ID, date, notes and completion (no "today" substitution).
            stage = (await save({ testResult: "PASS" })).stages[0];
            assert.deepEqual([stage.jobId, stage.testResult, stage.testDate, stage.notes, stage.completed], ["JOB-2026-014", "PASS", "2026-09-28", "Trade test", true]);

            stage = (await save({ jobId: null, testResult: null, testDate: null })).stages[0];
            assert.deepEqual([stage.jobId, stage.testResult, stage.testDate], [null, null, null]);

            const { stages } = await getCandidate({ db, passportId: "N1023757" });
            assert.ok(stages.slice(1).every((s) => s.jobId === null && s.testResult === null && s.testDate === null));
            // The registration comment's Candidate Details row is not touched.
            assert.deepEqual(db.state.stages.map((s) => [s.stage, s.testResult ?? null, s.notes]), [
                ["CANDIDATE_DETAILS", null, "Prefers morning calls"],
                ["TEST_DETAILS", null, "Trade test"],
            ]);
        });

        test("an existing stage row without a test still reads correctly", async () => {
            const db = createFakeDb({ stages: [{ passportId: "N1023757", stage: "TEST_DETAILS", completed: true, completedAt: new Date(), notes: "Old note" }] });
            await registered(db);
            const stage = (await getCandidate({ db, passportId: "N1023757" })).stages[0];
            assert.deepEqual([stage.notes, stage.completed, stage.jobId, stage.testResult, stage.testDate], ["Old note", true, null, null, null]);
        });

        test("the route takes the result and date for Test details only", async () => {
            const app = express();
            app.use(express.json());
            const db = createFakeDb();
            await registered(db);
            app.use("/api/admin", createAdminRouter({ db, bucket: createFakeBucket(), requireAdmin: (req, res, next) => { req.admin = { ...ADMIN, role: "ANALYST" }; next(); }, apiLimiter: noRateLimit }));
            app.use(errorHandler);
            const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
            const put = (stage, body) => fetch(`http://127.0.0.1:${server.address().port}/api/admin/candidates/N1023757/stages/${stage}`, {
                method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
            });
            try {
                const saved = await put("TEST_DETAILS", { jobId: "JOB-2026-014", testResult: "PASS", testDate: "2026-09-28" });
                assert.equal(saved.status, 200);
                const body = await saved.json();
                assert.deepEqual([body.stages[0].jobId, body.stages[0].testResult, body.stages[0].testDate], ["JOB-2026-014", "PASS", "2026-09-28"]);
                assert.equal((await put("IVS_INTERVIEW", { testResult: "PASS" })).status, 400);
                assert.equal((await put("IVS_INTERVIEW", { jobId: "JOB-1" })).status, 400);
            } finally {
                server.close();
            }
        });
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

    test("all three police reports and both affidavits can be on record together; each variant replaces only itself", async () => {
        const db = createFakeDb();
        const bucket = createFakeBucket();
        await registered(db);
        let n = 0;
        const upload = (documentType, variant) => uploadCandidateDocument({
            db, bucket, admin: ADMIN, passportId: "N1023757", documentType, variant, mimeType: "application/pdf",
            buffer: Buffer.concat([PDF, Buffer.from(`file-${n++}`)]), originalFileName: `${documentType}-${variant}.pdf`,
        });
        await upload("POLICE_REPORT", "SL_VERIFIED");
        await upload("POLICE_REPORT", "ROMANIA");
        await upload("POLICE_REPORT", "SL_NORMAL");
        await upload("AFFIDAVIT", "ENGLISH");
        let result = await upload("AFFIDAVIT", "SINHALA");

        const names = (type) => Object.fromEntries(Object.entries(result.variantDocuments[type].byVariant).map(([v, d]) => [v, d?.originalFilename ?? null]));
        assert.deepEqual(names("POLICE_REPORT"), { SL_VERIFIED: "POLICE_REPORT-SL_VERIFIED.pdf", ROMANIA: "POLICE_REPORT-ROMANIA.pdf", SL_NORMAL: "POLICE_REPORT-SL_NORMAL.pdf" });
        assert.deepEqual(names("AFFIDAVIT"), { ENGLISH: "AFFIDAVIT-ENGLISH.pdf", SINHALA: "AFFIDAVIT-SINHALA.pdf" });
        assert.equal(db.state.documents.filter((d) => d.verificationStatus === "VERIFIED").length, 5, "nothing superseded");
        assert.equal(result.variantDocuments.POLICE_REPORT.untyped, null);
        assert.ok(result.requiredDocuments.find((r) => r.documentType === "POLICE_REPORT").included);

        // A new Romania report supersedes the old Romania one only.
        result = await upload("POLICE_REPORT", "ROMANIA");
        const police = db.state.documents.filter((d) => d.documentType === "POLICE_REPORT").map((d) => [d.documentVariant, d.verificationStatus]);
        assert.deepEqual(police, [["SL_VERIFIED", "VERIFIED"], ["ROMANIA", "SUPERSEDED"], ["SL_NORMAL", "VERIFIED"], ["ROMANIA", "VERIFIED"]]);
        assert.equal(result.variantDocuments.POLICE_REPORT.byVariant.ROMANIA.originalFilename, "POLICE_REPORT-ROMANIA.pdf");
        assert.equal(db.state.auditLogs.at(-1).previousStatus, "VERIFIED", "it replaced a Romania report");
        assert.equal(db.state.auditLogs[1].previousStatus, "NONE", "the first Romania report replaced nothing (SL Verified was already there)");

        // Removing one variant leaves the others.
        const slNormal = result.variantDocuments.POLICE_REPORT.byVariant.SL_NORMAL.documentId;
        result = await removeCandidateDocument({ db, bucket, admin: ADMIN, passportId: "N1023757", documentId: slNormal, reason: "Wrong file" });
        assert.equal(result.variantDocuments.POLICE_REPORT.byVariant.SL_NORMAL, null);
        assert.ok(result.variantDocuments.POLICE_REPORT.byVariant.SL_VERIFIED);
        assert.ok(result.variantDocuments.POLICE_REPORT.byVariant.ROMANIA);
    });

    test("a police report without a variant (e.g. received on WhatsApp) is shown as untyped and isn't replaced by a typed upload", async () => {
        const legacy = { documentId: "wa-1", passportId: "N1023757", documentType: "POLICE_REPORT", documentVariant: null, verificationStatus: "VERIFIED", originalFilename: "report.jpg", receivedDate: new Date("2026-09-01"), createdDate: new Date("2026-09-01") };
        const db = createFakeDb({ documents: [legacy] });
        const bucket = createFakeBucket();
        await registered(db);
        let result = await getCandidate({ db, passportId: "N1023757" });
        assert.equal(result.variantDocuments.POLICE_REPORT.untyped.documentId, "wa-1");
        assert.deepEqual(Object.values(result.variantDocuments.POLICE_REPORT.byVariant), [null, null, null]);
        assert.ok(!result.requiredDocuments.find((r) => r.documentType === "POLICE_REPORT").included, "it does not count as the full police report");

        result = await uploadCandidateDocument({ db, bucket, admin: ADMIN, passportId: "N1023757", documentType: "POLICE_REPORT", variant: "SL_VERIFIED", mimeType: "application/pdf", buffer: PDF });
        assert.equal(db.state.documents.find((d) => d.documentId === "wa-1").verificationStatus, "VERIFIED");
        assert.equal(result.variantDocuments.POLICE_REPORT.untyped.documentId, "wa-1");
        assert.ok(result.variantDocuments.POLICE_REPORT.byVariant.SL_VERIFIED);
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

    test("the original file name is stripped of paths and control characters, and never trusted", () => {
        assert.equal(cleanOriginalFileName("C:\\scans\\passport copy.pdf", null), "passport copy.pdf");
        assert.equal(cleanOriginalFileName("../../etc/x\u0000.pdf", null), "x.pdf");
        assert.equal(cleanOriginalFileName("   ", "fallback"), "fallback");
        assert.equal(cleanOriginalFileName(42, null), null);
        assert.equal(cleanOriginalFileName(undefined, null), null);
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

    test("a call keeps the date and time it took place; newest call first; no time given = now", async () => {
        const db = createFakeDb();
        await registered(db);
        const add = (body) => addCallLog({ db, admin: ADMIN, passportId: "N1023757", values: parseCallLogBody(body).values });
        await add({ note: "Asked about the medical", calledAt: "2026-09-30T10:15:00+05:30" });
        await add({ note: "Said the police report is ready", calledAt: "2026-10-01T16:45:00+05:30" });
        const before = Date.now();
        const { items } = await add({ note: "No answer" });

        assert.deepEqual(items.map((i) => i.note), ["No answer", "Said the police report is ready", "Asked about the medical"]);
        assert.ok(items[1].calledAt.toISOString().startsWith("2026-10-01T11:15:"), "16:45 in Sri Lanka");
        assert.ok(items[2].calledAt.toISOString().startsWith("2026-09-30T04:45:"));
        assert.ok(items[0].calledAt.getTime() >= before, "no time given: now");
    });

    test("call note validation: a short note is required; the time must be a real date and time, not in the future", () => {
        const now = new Date("2026-10-02T09:00:00Z");
        const fields = (body) => parseCallLogBody(body, { now }).errors?.map((e) => e.field);
        assert.deepEqual(parseCallLogBody({ note: "  Will send medical  " }, { now }).values, { note: "Will send medical", calledAt: null });
        assert.deepEqual(fields({}), ["note"]);
        assert.deepEqual(fields({ note: "x".repeat(501) }), ["note"], "a short note: at most 500 characters");
        assert.equal(parseCallLogBody({ note: "x".repeat(500) }, { now }).errors, undefined);
        assert.deepEqual(fields({ note: "x", calledAt: "yesterday" }), ["calledAt"]);
        assert.deepEqual(fields({ note: "x", calledAt: "2026-10-02T14:30" }), ["calledAt"], "the offset is required");
        assert.deepEqual(fields({ note: "x", calledAt: "2026-02-30T10:00:00+05:30" }), ["calledAt"]);
        assert.deepEqual(fields({ note: "x", calledAt: 1727850000000 }), ["calledAt"]);
        assert.deepEqual(fields({ note: "x", calledAt: "2026-10-02T15:00:00+05:30" }), ["calledAt"], "later today is the future");
        assert.equal(parseCallLogBody({ note: "x", calledAt: "2026-10-02T14:33:00+05:30" }, { now }).errors, undefined, "a few minutes of clock difference are fine");
    });
});

describe("candidate routes: roles", () => {
    async function call(role, method, path, body, db = createFakeDb(), { bucket = createFakeBucket() } = {}) {
        const app = express();
        app.use(express.json());
        const requireAdmin = (req, res, next) => { req.admin = { ...ADMIN, role }; next(); };
        app.use("/api/admin", createAdminRouter({ db, bucket, requireAdmin, apiLimiter: noRateLimit }));
        app.use(errorHandler);
        const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
        try {
            const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
                method,
                headers: { "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: await response.json() };
        } finally {
            server.close();
        }
    }

    // The admin's upload through the routes: target, the browser's PUT to
    // storage, finalize. Returns the finalize response (or the target's, when
    // that one is refused).
    async function directUpload(role, passportIdInUrl, db, bucket, { type, variant, mimeType = "application/pdf", buffer = PDF, fileName = "scan.pdf" }) {
        const described = { type, ...(variant ? { variant } : {}), mimeType, fileName };
        const target = await call(role, "POST", `/api/admin/candidates/${passportIdInUrl}/documents/upload-target`, { ...described, fileSize: buffer.length }, db, { bucket });
        if (target.status !== 200) return target;
        bucket.browserPut(bucket.signedUploads.at(-1), buffer, mimeType);
        return call(role, "POST", `/api/admin/candidates/${passportIdInUrl}/documents/finalize`, { ...described, uploadId: target.body.uploadId }, db, { bucket });
    }

    test("an UNKNOWN role cannot list candidates or register, edit stages or add call notes", async () => {
        assert.equal((await call("UNKNOWN", "GET", "/api/admin/candidates")).status, 403);
        assert.equal((await call("UNKNOWN", "POST", "/api/admin/candidates", VALID_BODY)).status, 403);
        assert.equal((await call("UNKNOWN", "PUT", "/api/admin/candidates/N1023757/stages/TEST_DETAILS", { completed: true })).status, 403);
        assert.equal((await call("UNKNOWN", "POST", "/api/admin/candidates/N1023757/call-logs", { note: "x" })).status, 403);
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
        const found = await call("ANALYST", "GET", "/api/admin/candidates/N1023757", undefined, db);
        assert.equal(found.status, 200);
        assert.equal(found.body.candidate.passportId, "n1023757");
        assert.equal(found.body.candidate.surname, "De Soysa");
        assert.equal((await call("ANALYST", "GET", "/api/admin/candidates/N9999999", undefined, db)).status, 404, "not found -> new registration");
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

            const upload = await directUpload("ANALYST", "N1023757", db, bucket, { type: "MEDICAL" });
            assert.equal(upload.status, 200);
            assert.match(bucket.signedUploads[0], /^clients\/n1023757\/medical\/upload_/, "staged in the stored record's folder");
            assert.equal(upload.body.documents.MEDICAL.verificationStatus, "VERIFIED");
            assert.deepEqual(db.state.documents.map((d) => d.passportId), ["n1023757"]);
            assert.deepEqual([...bucket.objects.keys()], ["clients/n1023757/medical/medical.pdf"]);

            assert.equal((await call("ANALYST", "POST", "/api/admin/candidates/N1023757/call-logs", { note: "Called" }, db)).status, 201);
            const logs = await call("ANALYST", "GET", "/api/admin/candidates/N1023757/call-logs", undefined, db);
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
            const upload = await directUpload("ADMIN", "NA444444", db, bucket, { type: "MEDICAL" });
            assert.equal(upload.status, 404);
            assert.equal(bucket.signedUploads.length, 0, "no upload URL issued");
            assert.equal(bucket.objects.size, 0);
            assert.equal(db.state.stages.length + db.state.callLogs.length + db.state.documents.length, 0);
        });

        test("roles are unchanged: an UNKNOWN still can't change the record", async () => {
            const db = createFakeDb({ users: [LEGACY] });
            assert.equal((await call("UNKNOWN", "PUT", "/api/admin/candidates/N1023757", DETAILS_BODY, db)).status, 403);
            assert.equal((await call("UNKNOWN", "PUT", "/api/admin/candidates/N1023757/stages/TEST_DETAILS", { completed: true }, db)).status, 403);
            assert.equal((await call("UNKNOWN", "POST", "/api/admin/candidates/N1023757/documents/upload-target", { type: "MEDICAL", mimeType: "application/pdf", fileSize: 100 }, db)).status, 403);
            assert.equal((await call("UNKNOWN", "POST", "/api/admin/candidates/N1023757/documents/finalize", { type: "MEDICAL", mimeType: "application/pdf", uploadId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" }, db)).status, 403);
            assert.equal((await call("UNKNOWN", "POST", "/api/admin/candidates/N1023757/call-logs", { note: "x" }, db)).status, 403);
            assert.equal(db.state.users[0].address, "Negombo");
        });
    });

    // The file goes browser -> storage; the API sees only JSON descriptions.
    describe("direct uploads through the routes", () => {
        const withCandidate = async () => {
            const db = createFakeDb();
            await registered(db);
            return { db, bucket: createFakeBucket() };
        };
        const target = (role, db, bucket, body, passportId = "N1023757") =>
            call(role, "POST", `/api/admin/candidates/${passportId}/documents/upload-target`, body, db, { bucket });

        test("ADMIN and ANALYST get an upload URL for one staged object in the candidate's folder; an UNKNOWN gets none", async () => {
            const { db, bucket } = await withCandidate();
            for (const role of ["ADMIN", "ANALYST"]) {
                const response = await target(role, db, bucket, { type: "MEDICAL", mimeType: "application/pdf", fileSize: 2048 });
                assert.equal(response.status, 200, role);
                assert.match(response.body.uploadId, /^[0-9a-f-]{36}$/);
                assert.equal(response.body.uploadUrl, `https://project.supabase.co/storage/v1/object/upload/sign/documents/clients/N1023757/medical/upload_${response.body.uploadId}.pdf?token=signed-${bucket.signedUploads.length}`);
                assert.equal(response.body.maxFileSize, 10 * 1024 * 1024);
            }
            assert.equal((await target("UNKNOWN", db, bucket, { type: "MEDICAL", mimeType: "application/pdf", fileSize: 2048 })).status, 403);
            assert.equal(bucket.signedUploads.length, 2, "nothing issued for the viewer");
            assert.equal(bucket.objects.size, 0, "the API itself stores nothing at this step");
        });

        test("the description is checked before any URL is issued: type, variant, MIME type, size; skill video takes videos only", async () => {
            const { db, bucket } = await withCandidate();
            const refused = [
                [{ type: "UNKNOWN_TYPE_XYZ", mimeType: "application/pdf", fileSize: 10 }, 400],
                [{ type: "POLICE_REPORT", mimeType: "application/pdf", fileSize: 10 }, 400],
                [{ type: "AFFIDAVIT", variant: "TAMIL", mimeType: "application/pdf", fileSize: 10 }, 400],
                [{ type: "MEDICAL", variant: "ENGLISH", mimeType: "application/pdf", fileSize: 10 }, 400],
                [{ type: "MEDICAL", mimeType: "application/pdf", fileSize: "big" }, 400],
                [{ type: "MEDICAL", mimeType: "application/zip", fileSize: 10 }, 422],
                [{ type: "MEDICAL", mimeType: "", fileSize: 10 }, 422],
                [{ type: "MEDICAL", mimeType: "application/pdf", fileSize: 0 }, 422],
                [{ type: "MEDICAL", mimeType: "application/pdf", fileSize: 10 * 1024 * 1024 + 1 }, 422],
                [{ type: "SKILL_VIDEO", mimeType: "application/pdf", fileSize: 10 }, 422],
                [{ type: "SKILL_VIDEO", mimeType: "image/jpeg", fileSize: 10 }, 422],
                [{ type: "SKILL_VIDEO", mimeType: "image/png", fileSize: 10 }, 422],
            ];
            for (const [body, status] of refused) {
                assert.equal((await target("ADMIN", db, bucket, body)).status, status, JSON.stringify(body));
            }
            assert.equal(bucket.signedUploads.length, 0);
            const video = await target("ADMIN", db, bucket, { type: "SKILL_VIDEO", mimeType: "application/pdf", fileSize: 10 });
            assert.equal(video.body.message, "This file type is not accepted. Use MP4, MOV or WebM.");

            for (const [mimeType, extension] of [["video/mp4", ".mp4"], ["video/quicktime", ".mov"], ["video/webm", ".webm"]]) {
                const ok = await target("ADMIN", db, bucket, { type: "SKILL_VIDEO", mimeType, fileSize: 4096 });
                assert.equal(ok.status, 200, mimeType);
                assert.ok(bucket.signedUploads.at(-1).endsWith(extension));
            }
            assert.equal((await target("ADMIN", db, bucket, { type: "POLICE_REPORT", variant: "ROMANIA", mimeType: "application/pdf", fileSize: 10 })).status, 200);
            assert.equal((await target("ADMIN", db, bucket, { type: "MEDICAL", mimeType: "application/pdf", fileSize: 10 }, "N9999999")).status, 404, "no such candidate");
        });

        test("finalize checks the stored bytes and records the document under its standard name; the staged object is gone", async () => {
            const { db, bucket } = await withCandidate();
            const done = await directUpload("ANALYST", "N1023757", db, bucket, { type: "POLICE_REPORT", variant: "SL_VERIFIED", fileName: "report scan.pdf" });
            assert.equal(done.status, 200);
            assert.equal(done.body.documents.POLICE_REPORT.variant, "SL_VERIFIED");
            assert.equal(done.body.documents.POLICE_REPORT.originalFilename, "N1023757 - POLICE_REPORT.PDF");
            assert.deepEqual([...bucket.objects.keys()], ["clients/N1023757/police-report/police_report.pdf"]);
            assert.deepEqual(db.state.documents.map((d) => [d.documentType, d.verificationStatus, d.storagePath, d.documentVariant]), [["POLICE_REPORT", "VERIFIED", "clients/N1023757/police-report/police_report.pdf", "SL_VERIFIED"]]);
            assert.deepEqual(db.state.auditLogs.map((a) => [a.action, a.previousStatus, a.newValue]), [["UPLOAD_DOCUMENT", "NONE", "SL_VERIFIED"]]);
        });

        test("a skill video is accepted as MP4, MOV or WebM; a PDF named as a video is refused and removed", async () => {
            const { db, bucket } = await withCandidate();
            for (const [mimeType, buffer] of [["video/mp4", MP4], ["video/quicktime", MOV], ["video/webm", WEBM]]) {
                assert.equal((await directUpload("ADMIN", "N1023757", db, bucket, { type: "SKILL_VIDEO", mimeType, buffer })).status, 200, mimeType);
            }
            assert.deepEqual([...bucket.objects.keys()], ["clients/N1023757/skill-video/skill_video.mp4", "clients/N1023757/skill-video/skill_video_v2.mov", "clients/N1023757/skill-video/skill_video_v3.webm"]);

            const disguised = await directUpload("ADMIN", "N1023757", db, bucket, { type: "SKILL_VIDEO", mimeType: "video/mp4", buffer: Buffer.concat([PDF, Buffer.from("x")]) });
            assert.equal(disguised.status, 422);
            assert.equal(bucket.objects.size, 3, "the staged object was removed");
            assert.equal(db.state.documents.length, 3);
        });

        test("the same file twice is still refused, and its staged copy removed", async () => {
            const { db, bucket } = await withCandidate();
            assert.equal((await directUpload("ADMIN", "N1023757", db, bucket, { type: "NIC" })).status, 200);
            const again = await directUpload("ADMIN", "N1023757", db, bucket, { type: "NIC" });
            assert.equal(again.status, 409);
            assert.equal(again.body.code, "DUPLICATE_FILE");
            assert.deepEqual([...bucket.objects.keys()], ["clients/N1023757/nic/nic.pdf"]);
            assert.equal(db.state.documents.length, 1);
        });

        test("replacing a document: the new file becomes current, the old one of that variant is superseded, no extra rows", async () => {
            const { db, bucket } = await withCandidate();
            await directUpload("ADMIN", "N1023757", db, bucket, { type: "AFFIDAVIT", variant: "ENGLISH" });
            const replaced = await directUpload("ADMIN", "N1023757", db, bucket, { type: "AFFIDAVIT", variant: "ENGLISH", buffer: Buffer.concat([PDF, Buffer.from("v2")]) });
            assert.equal(replaced.status, 200);
            assert.equal(replaced.body.variantDocuments.AFFIDAVIT.byVariant.ENGLISH.variant, "ENGLISH");
            assert.deepEqual(db.state.documents.map((d) => [d.storedFilename, d.verificationStatus]), [["affidavit.pdf", "SUPERSEDED"], ["affidavit_v2.pdf", "VERIFIED"]]);
            assert.deepEqual(db.state.auditLogs.map((a) => a.previousStatus), ["NONE", "VERIFIED"]);

            // The other variant is kept alongside, not a replacement.
            const sinhala = await directUpload("ADMIN", "N1023757", db, bucket, { type: "AFFIDAVIT", variant: "SINHALA", buffer: Buffer.concat([PDF, Buffer.from("v3")]) });
            assert.equal(sinhala.status, 200);
            assert.deepEqual(db.state.documents.map((d) => [d.documentVariant, d.verificationStatus]), [["ENGLISH", "SUPERSEDED"], ["ENGLISH", "VERIFIED"], ["SINHALA", "VERIFIED"]]);
            assert.ok(sinhala.body.variantDocuments.AFFIDAVIT.byVariant.ENGLISH);
            assert.ok(sinhala.body.variantDocuments.AFFIDAVIT.byVariant.SINHALA);
        });

        test("finalize without an upload, or for another candidate or type, records nothing", async () => {
            const { db, bucket } = await withCandidate();
            await registered(db, { passportId: "P7654321", nic: "200012345678" });
            const issued = await target("ADMIN", db, bucket, { type: "MEDICAL", mimeType: "application/pdf", fileSize: PDF.length });
            const finalize = (passportId, body) => call("ADMIN", "POST", `/api/admin/candidates/${passportId}/documents/finalize`, { type: "MEDICAL", mimeType: "application/pdf", uploadId: issued.body.uploadId, ...body }, db, { bucket });

            const notUploaded = await finalize("N1023757", {});
            assert.equal(notUploaded.status, 404);
            assert.equal(notUploaded.body.code, "UPLOAD_NOT_FOUND");

            bucket.browserPut(bucket.signedUploads[0], PDF, "application/pdf");
            assert.equal((await finalize("P7654321", {})).status, 404, "candidate A's upload can't be finalized for candidate B");
            assert.equal((await finalize("N1023757", { type: "AGREEMENT" })).status, 404, "nor as another document type");
            assert.equal((await finalize("N1023757", { uploadId: "not-a-uuid" })).status, 400);
            assert.equal(db.state.documents.length, 0);
            assert.equal(bucket.objects.size, 1, "A's staged upload is untouched");

            assert.equal((await finalize("N1023757", {})).status, 200, "and still finalizes for A");
            assert.deepEqual(db.state.documents.map((d) => d.passportId), ["N1023757"]);
        });

        test("a file stored with another type than the one checked is refused and removed", async () => {
            const { db, bucket } = await withCandidate();
            const issued = await target("ADMIN", db, bucket, { type: "MEDICAL", mimeType: "application/pdf", fileSize: PDF.length });
            bucket.browserPut(bucket.signedUploads[0], PDF, "text/html");
            const response = await call("ADMIN", "POST", "/api/admin/candidates/N1023757/documents/finalize", { type: "MEDICAL", mimeType: "application/pdf", uploadId: issued.body.uploadId }, db, { bucket });
            assert.equal(response.status, 422);
            assert.equal(bucket.objects.size, 0);
            assert.equal(db.state.documents.length, 0);
        });

        test("no route takes a file body: the old upload route is gone and finalize ignores anything but JSON", async () => {
            const router = createAdminRouter({ db: createFakeDb(), bucket: createFakeBucket(), requireAdmin: (req, res, next) => next(), apiLimiter: noRateLimit });
            const documentRoutes = router.stack.filter((layer) => layer.route?.path.includes("/documents")).map((layer) => layer.route.path);
            // All JSON only (remove takes { reason }).
            assert.deepEqual(documentRoutes.filter((path) => path.startsWith("/candidates")), ["/candidates/:passportId/documents/upload-target", "/candidates/:passportId/documents/finalize", "/candidates/:passportId/documents/:documentId/remove"]);
            assert.equal((await call("ADMIN", "POST", "/api/admin/candidates/N1023757/documents", undefined)).status, 404);

            const { db, bucket } = await withCandidate();
            const app = express();
            app.use(express.json());
            app.use("/api/admin", createAdminRouter({ db, bucket, requireAdmin: (req, res, next) => { req.admin = ADMIN; next(); }, apiLimiter: noRateLimit }));
            app.use(errorHandler);
            const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
            try {
                const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/candidates/N1023757/documents/finalize?type=MEDICAL`, {
                    method: "POST", headers: { "content-type": "application/pdf" }, body: PDF,
                });
                assert.equal(response.status, 400, "a file body is not read as a document");
            } finally {
                server.close();
            }
            assert.equal(db.state.documents.length, 0);
            assert.equal(bucket.objects.size, 0);
        });
    });
});

describe("removing a document", () => {
    const seed = async () => {
        const db = createFakeDb();
        const bucket = createFakeBucket();
        await registered(db);
        const upload = (documentType, buffer, variant = null) => uploadCandidateDocument({ db, bucket, admin: ADMIN, passportId: "N1023757", documentType, variant, mimeType: "application/pdf", buffer });
        return { db, bucket, upload };
    };
    const remove = (db, bucket, documentId, passportId = "N1023757", reason = "Wrong file uploaded") =>
        removeCandidateDocument({ db, bucket, admin: ADMIN, passportId, documentId, reason });

    test("the reason is required, at most 500 characters", () => {
        assert.ok(parseRemoveDocumentBody({}).errors);
        assert.ok(parseRemoveDocumentBody({ reason: "   " }).errors);
        assert.ok(parseRemoveDocumentBody({ reason: "x".repeat(501) }).errors);
        assert.ok(parseRemoveDocumentBody([]).errors);
        assert.deepEqual(parseRemoveDocumentBody({ reason: " Wrong file " }).values, { reason: "Wrong file" });
    });

    test("removes the record and its file, audits it, and empties the slot; stage completion follows", async () => {
        const { db, bucket, upload } = await seed();
        let details = await upload("PASSPORT", PDF);
        assert.equal(details.stages.find((s) => s.stage === "CANDIDATE_DETAILS").completed, true);

        details = await remove(db, bucket, details.documents.PASSPORT.documentId);
        assert.equal(details.documents.PASSPORT, null);
        assert.equal(db.state.documents.length, 0);
        assert.equal(bucket.objects.size, 0, "the file is deleted");
        assert.deepEqual(details.stages.find((s) => s.stage === "CANDIDATE_DETAILS").missing, ["passport document"]);
        const audit = db.state.auditLogs.at(-1);
        assert.deepEqual([audit.action, audit.previousStatus, audit.newStatus, audit.reason, audit.documentType, audit.passportId], ["REMOVE_DOCUMENT", "VERIFIED", "REMOVED", "Wrong file uploaded", "PASSPORT", "N1023757"]);
    });

    test("the same file can be uploaded again after it was removed", async () => {
        const { db, bucket, upload } = await seed();
        const first = await upload("NIC", PDF);
        await remove(db, bucket, first.documents.NIC.documentId);
        const again = await upload("NIC", PDF);
        assert.equal(again.documents.NIC.verificationStatus, "VERIFIED");
        assert.equal(db.state.documents.length, 1);
    });

    test("after removing a replacement, earlier versions stay as history and the slot stays empty", async () => {
        const { db, bucket, upload } = await seed();
        await upload("MEDICAL", PDF);
        const replaced = await upload("MEDICAL", Buffer.concat([PDF, Buffer.from("v2")]));
        const details = await remove(db, bucket, replaced.documents.MEDICAL.documentId);
        assert.equal(details.documents.MEDICAL, null);
        assert.deepEqual(db.state.documents.map((d) => [d.storedFilename, d.verificationStatus]), [["medical.pdf", "SUPERSEDED"]]);
        assert.deepEqual([...bucket.objects.keys()], ["clients/N1023757/medical/medical.pdf"]);
    });

    test("only this candidate's current document: a superseded version, another candidate's, or one already removed is not found", async () => {
        const { db, bucket, upload } = await seed();
        await registered(db, { passportId: "P7654321", nic: "200012345678" });
        const old = await upload("AGREEMENT", PDF);
        await upload("AGREEMENT", Buffer.concat([PDF, Buffer.from("v2")]));
        const superseded = old.documents.AGREEMENT.documentId;
        await assert.rejects(remove(db, bucket, superseded), (error) => error.code === "DOCUMENT_NOT_FOUND" && error.status === 404);

        const current = db.state.documents.find((d) => d.verificationStatus === "VERIFIED").documentId;
        await assert.rejects(remove(db, bucket, current, "P7654321"), (error) => error.code === "DOCUMENT_NOT_FOUND", "candidate B can't remove A's document");
        assert.equal(db.state.documents.length, 2, "nothing removed");
        assert.equal(bucket.objects.size, 2);

        await remove(db, bucket, current);
        await assert.rejects(remove(db, bucket, current), (error) => error.code === "DOCUMENT_NOT_FOUND", "already removed");
        assert.equal(db.state.auditLogs.filter((a) => a.action === "REMOVE_DOCUMENT").length, 1);
    });

    test("a file another record still points at is kept", async () => {
        const { db, bucket, upload } = await seed();
        const details = await upload("PASSPORT", PDF);
        const row = db.state.documents[0];
        db.state.documents.push({ ...row, documentId: "f1c2a3b4-0000-4000-8000-000000000099", documentType: "UNKNOWN_TYPE_XYZ", fileSha256: "other" });
        await remove(db, bucket, details.documents.PASSPORT.documentId);
        assert.equal(bucket.objects.size, 1, "still referenced");
    });

    test("a file that can't be deleted doesn't undo the removal", async () => {
        const { db, bucket, upload } = await seed();
        const details = await upload("PASSPORT", PDF);
        bucket.remove = async () => ({ error: { message: "storage unavailable" } });
        const warnings = [];
        const warn = console.warn;
        console.warn = (...args) => warnings.push(args);
        try {
            const after = await remove(db, bucket, details.documents.PASSPORT.documentId);
            assert.equal(after.documents.PASSPORT, null);
        } finally {
            console.warn = warn;
        }
        assert.equal(db.state.documents.length, 0);
        assert.equal(warnings.length, 1);
        assert.ok(!JSON.stringify(warnings).includes("N1023757"), "the passport number isn't logged");
    });

    test("the route: ANALYST and ADMIN may remove with a reason; an UNKNOWN may not; bad input is refused", async () => {
        const { db, bucket, upload } = await seed();
        const details = await upload("NIC", PDF);
        const documentId = details.documents.NIC.documentId;
        const request = async (role, path, body) => {
            const app = express();
            app.use(express.json());
            app.use("/api/admin", createAdminRouter({ db, bucket, requireAdmin: (req, res, next) => { req.admin = { ...ADMIN, role }; next(); }, apiLimiter: noRateLimit }));
            app.use(errorHandler);
            const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
            try {
                const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
                return { status: response.status, body: await response.json() };
            } finally {
                server.close();
            }
        };
        const path = `/api/admin/candidates/N1023757/documents/${documentId}/remove`;
        assert.equal((await request("UNKNOWN", path, { reason: "x" })).status, 403);
        assert.equal((await request("ANALYST", path, {})).status, 400, "reason required");
        assert.equal((await request("ANALYST", "/api/admin/candidates/N1023757/documents/not-an-id/remove", { reason: "x" })).status, 400);
        assert.equal(db.state.documents.length, 1, "nothing removed yet");

        const removed = await request("ANALYST", path, { reason: "Wrong NIC" });
        assert.equal(removed.status, 200);
        assert.equal(removed.body.documents.NIC, null);
        assert.equal((await request("ADMIN", path, { reason: "again" })).status, 404);
    });
});

describe("file size limits: 50 MB for a skill video, 10 MB for documents", () => {
    const MB = 1024 * 1024;
    // A valid MP4 header followed by padding up to the given size.
    const mp4Of = (bytes) => Buffer.concat([MP4, Buffer.alloc(bytes - MP4.length)]);

    test("declared sizes: a video may exceed 10 MB up to 50 MB; documents stay at 10 MB", () => {
        assert.equal(checkDeclaredFile({ documentType: "SKILL_VIDEO", mimeType: "video/mp4", fileSize: 10 * MB + 1 }), null);
        assert.equal(checkDeclaredFile({ documentType: "SKILL_VIDEO", mimeType: "video/webm", fileSize: 50 * MB }), null);
        assert.match(checkDeclaredFile({ documentType: "SKILL_VIDEO", mimeType: "video/mp4", fileSize: 50 * MB + 1 }), /larger than 50 MB/);
        for (const documentType of ["PASSPORT", "NIC", "MEDICAL", "POLICE_REPORT", "AGREEMENT", "AFFIDAVIT"]) {
            assert.match(checkDeclaredFile({ documentType, mimeType: "application/pdf", fileSize: 10 * MB + 1 }), /larger than 10 MB/, documentType);
        }
    });

    test("the stored bytes are held to the same limits", () => {
        assert.equal(validateCandidateUpload({ documentType: "SKILL_VIDEO", mimeType: "video/mp4", buffer: mp4Of(12 * MB) }), null);
        assert.match(validateCandidateUpload({ documentType: "SKILL_VIDEO", mimeType: "video/mp4", buffer: mp4Of(50 * MB + 1) }), /larger than 50 MB/);
        const bigPdf = Buffer.concat([PDF, Buffer.alloc(10 * MB + 1 - PDF.length)]);
        assert.match(validateCandidateUpload({ documentType: "MEDICAL", mimeType: "application/pdf", buffer: bigPdf }), /larger than 10 MB/);
    });

    test("a 12 MB skill video goes through target and finalize; the target reports the 50 MB limit", async () => {
        const db = createFakeDb();
        const bucket = createFakeBucket();
        await registered(db);
        const video = mp4Of(12 * MB);
        const target = await createUploadTarget({ db, bucket, passportId: "N1023757", documentType: "SKILL_VIDEO", mimeType: "video/mp4", fileSize: video.length });
        assert.equal(target.maxFileSize, 50 * MB);
        const document = await createUploadTarget({ db, bucket, passportId: "N1023757", documentType: "MEDICAL", mimeType: "application/pdf", fileSize: 10 });
        assert.equal(document.maxFileSize, 10 * MB);

        bucket.browserPut(bucket.signedUploads[0], video, "video/mp4");
        const done = await finalizeUpload({ db, bucket, admin: ADMIN, passportId: "N1023757", uploadId: target.uploadId, documentType: "SKILL_VIDEO", variant: null, mimeType: "video/mp4", originalFileName: "skills.mp4" });
        assert.equal(done.documents.SKILL_VIDEO.originalFilename, "N1023757 - SKILL_VIDEO.MP4");
        assert.equal(db.state.documents[0].fileSize, BigInt(12 * MB));
    });

    test("a staged video over 50 MB is refused before it is read, and removed", async () => {
        const db = createFakeDb();
        const bucket = createFakeBucket();
        await registered(db);
        const target = await createUploadTarget({ db, bucket, passportId: "N1023757", documentType: "SKILL_VIDEO", mimeType: "video/mp4", fileSize: 20 * MB });
        bucket.browserPut(bucket.signedUploads[0], mp4Of(50 * MB + 1), "video/mp4"); // bigger than it said
        let downloaded = false;
        const download = bucket.download;
        bucket.download = async (path) => { downloaded = true; return download(path); };
        await assert.rejects(
            finalizeUpload({ db, bucket, admin: ADMIN, passportId: "N1023757", uploadId: target.uploadId, documentType: "SKILL_VIDEO", variant: null, mimeType: "video/mp4", originalFileName: null }),
            (error) => error.code === "FILE_REJECTED" && /larger than 50 MB/.test(error.message),
        );
        assert.equal(downloaded, false);
        assert.equal(bucket.objects.size, 0);
        assert.equal(db.state.documents.length, 0);
    });
});

describe("direct uploads: storage handling", () => {
    test("the declared file is checked like the bytes later are", () => {
        assert.equal(checkDeclaredFile({ documentType: "MEDICAL", mimeType: "image/png", fileSize: 10 }), null);
        assert.equal(checkDeclaredFile({ documentType: "SKILL_VIDEO", mimeType: "video/webm", fileSize: 10 }), null);
        assert.match(checkDeclaredFile({ documentType: "SKILL_VIDEO", mimeType: "image/png", fileSize: 10 }), /MP4, MOV or WebM/);
        assert.match(checkDeclaredFile({ documentType: "PASSPORT", mimeType: "video/mp4", fileSize: 10 }), /PDF, JPG or PNG/);
        assert.match(checkDeclaredFile({ documentType: "PASSPORT", mimeType: "application/pdf", fileSize: 10 * 1024 * 1024 + 1 }), /larger than 10 MB/);
        assert.equal(checkDeclaredFile({ documentType: "PASSPORT", mimeType: "application/pdf" }), null, "size is optional at finalization");
        assert.deepEqual(parseUploadTargetBody({ type: "MEDICAL", mimeType: " Application/PDF; x=1 ", fileSize: 5 }).values, { documentType: "MEDICAL", variant: null, mimeType: "application/pdf", fileSize: 5 });
        assert.ok(parseFinalizeUploadBody({ type: "MEDICAL", mimeType: "application/pdf", uploadId: "../../x" }).errors);
        assert.ok(parseUploadTargetBody([]).errors);
    });

    test("a record that can't be written after the move removes the stored object", async () => {
        const db = createFakeDb();
        const bucket = createFakeBucket();
        await registered(db);
        const { uploadId } = await createUploadTarget({ db, bucket, passportId: "N1023757", documentType: "AGREEMENT", mimeType: "application/pdf", fileSize: PDF.length });
        bucket.browserPut(bucket.signedUploads[0], PDF, "application/pdf");
        db.document.create = async () => { throw new Error("database down"); };
        await assert.rejects(finalizeUpload({ db, bucket, admin: ADMIN, passportId: "N1023757", uploadId, documentType: "AGREEMENT", variant: null, mimeType: "application/pdf", originalFileName: null }), /upload removed/);
        assert.equal(bucket.objects.size, 0, "neither the staged nor the moved object is left");
        assert.equal(db.state.documents.length, 0);
    });

    test("a name already taken in storage is skipped, never overwritten", async () => {
        const db = createFakeDb();
        const bucket = createFakeBucket();
        await registered(db);
        await bucket.upload("clients/N1023757/medical/medical.pdf", Buffer.from("an older file with no record"), { contentType: "application/pdf" });
        const { uploadId } = await createUploadTarget({ db, bucket, passportId: "N1023757", documentType: "MEDICAL", mimeType: "application/pdf", fileSize: PDF.length });
        bucket.browserPut(bucket.signedUploads[0], PDF, "application/pdf");
        await finalizeUpload({ db, bucket, admin: ADMIN, passportId: "N1023757", uploadId, documentType: "MEDICAL", variant: null, mimeType: "application/pdf", originalFileName: null });
        assert.equal(bucket.objects.get("clients/N1023757/medical/medical.pdf").toString(), "an older file with no record");
        assert.equal(db.state.documents[0].storagePath, "clients/N1023757/medical/medical_v2.pdf");
    });

    test("a staged upload never finalized is removed when the next target is requested; documents and fresh uploads are kept", async () => {
        const db = createFakeDb();
        const bucket = createFakeBucket();
        await registered(db);
        await uploadCandidateDocument({ db, bucket, admin: ADMIN, passportId: "N1023757", documentType: "MEDICAL", variant: null, mimeType: "application/pdf", buffer: PDF });
        const now = new Date("2026-10-01T12:00:00.000Z");
        const first = await createUploadTarget({ db, bucket, passportId: "N1023757", documentType: "MEDICAL", mimeType: "application/pdf", fileSize: 10, now });
        bucket.browserPut(bucket.signedUploads[0], PDF, "application/pdf", new Date(now.getTime() - STAGED_UPLOAD_MAX_AGE_MS - 1000));
        const second = await createUploadTarget({ db, bucket, passportId: "N1023757", documentType: "MEDICAL", mimeType: "application/pdf", fileSize: 10, now });
        bucket.browserPut(bucket.signedUploads[1], PNG, "application/pdf", now);

        await createUploadTarget({ db, bucket, passportId: "N1023757", documentType: "MEDICAL", mimeType: "application/pdf", fileSize: 10, now });
        assert.deepEqual([...bucket.objects.keys()].sort(), ["clients/N1023757/medical/medical.pdf", `clients/N1023757/medical/upload_${second.uploadId}.pdf`]);
        assert.ok(first.uploadId !== second.uploadId);
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
