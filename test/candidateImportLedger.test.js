// Bulk candidate import: the per-import CHANGE LEDGER (candidateImportLedger.js, table
// candidate_import_change) end to end on a real PostgreSQL (PGlite, every migration).
// SYNTHETIC candidates, users, Clients and Agents only.
//
// The ledger records, in the same transaction as each chunk's writes, every change an import makes, so a
// later rollback can reverse exactly that and only where nothing has changed it since. These tests check
// what is recorded (new and existing candidates, stages, allocation, Clients / Agents, Jobs and their
// members), that it is atomic and never duplicated (failed, retried and repeated chunks), that it is
// owned by one import, that it holds no personal data, and that assessImportLedger (read-only) tells which
// entries could still be reversed and which have a conflict.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { authIdFor } from "./helpers/fakeSupabaseAuth.js";
import {
    IMPORT_CHUNK_SIZE, chunkRows, commitChunk, finishImport, previewImport,
} from "../src/services/candidateImportService.js";
import { createCandidate, parseCandidateBody } from "../src/services/candidateService.js";
import {
    ASSESSMENT, LEDGER_ENTITY as E, LEDGER_OP, ROLLBACK_ACTION, assessImportLedger, canonicalValue, createLedger, digestOf, ledgerValue, matchesWritten,
} from "../src/services/candidateImportLedger.js";

const ADMIN = { adminId: "admin-ADMIN", role: "ADMIN", name: "Admin User" };
const USERS = { "admin-ADMIN": ["Admin User", "ADMIN"], "u-john": ["John Silva", "ANALYST"], "u-anna": ["Anna Other", "ANALYST"] };
const HEADERS = [
    "PASSPORT NUMBER", "SURNAME", "OTHER NAME", "NIC NUMBER", "WHATSAPP NUMBER", "JOB ROLE", "OFFICER", "VISA STATUS", "INTERVIEW DATE", "INTERVIEW PASS FAIL",
    "COMPANY", "COMPANY NUMBER", "AGENT", "UNIQUE NUMBER", "ADDRESS", "BIRTH DATE", "SHIRT SIZE", "FATHER NAME",
];
const TODAY = new Date("2026-11-04T06:00:00Z");

let database;
let prisma;
let pg;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const [adminId, [name, role]] of Object.entries(USERS)) {
        await prisma.user.create({ data: { adminId, authUserId: authIdFor(adminId), name, email: `${adminId}@example.invalid`, role, status: "ACTIVE", activatedAt: new Date() } });
    }
    await prisma.jobType.upsert({ where: { code: "PLASTER" }, create: { code: "PLASTER", name: "PLASTER" }, update: {} });
});
after(async () => database?.close());
beforeEach(async () => {
    // candidate_import_change goes with its import (ON DELETE CASCADE). audit_logs is append-only: tests read their own entries.
    await pg.exec(`
        DELETE FROM "candidate_import"; DELETE FROM "candidate_allocation"; DELETE FROM "candidate_additional_details";
        DELETE FROM "import_job_group"; DELETE FROM "job_candidate"; DELETE FROM "job_job_type"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "candidate_stages"; DELETE FROM "candidate_verification"; DELETE FROM "documents"; DELETE FROM "candidate";
        DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent"; DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";
    `);
});

// ---------------------------------------------------------------- synthetic rows and helpers

const pad = (n, width) => String(n).padStart(width, "0");
const passportOf = (i) => `N7${pad(i, 6)}`;
const SECRETS = (i) => [passportOf(i), `SYNTHSURNAME${i}`, `SYNTH GIVEN ${i}`, `${710000000 + i}V`, `075${pad(i, 7)}`, `${i} Synthetic Road`];
// i: the row; u: UNIQUE NUMBER; d: INTERVIEW DATE (DD.MM.YYYY).
function row(i, u = 3100, d = "11.07.2026", overrides = {}) {
    return {
        rowNumber: i + 1,
        values: {
            "PASSPORT NUMBER": passportOf(i), SURNAME: `SYNTHSURNAME${i}`, "OTHER NAME": `SYNTH GIVEN ${i}`, "NIC NUMBER": `${710000000 + i}V`,
            "WHATSAPP NUMBER": `075${pad(i, 7)}`, "JOB ROLE": "Plaster", OFFICER: "John", "INTERVIEW DATE": d, "INTERVIEW PASS FAIL": "PASS",
            COMPANY: "Synth Builders", AGENT: "Synth Agency", "UNIQUE NUMBER": u === null ? "" : String(u),
            ADDRESS: `${i} Synthetic Road`, "BIRTH DATE": "05.03.1990", "SHIRT SIZE": "2XL", "FATHER NAME": "SYNTHFATHER",
            ...overrides,
        },
    };
}
const renumber = (rows) => rows.map((r, k) => ({ ...r, rowNumber: k + 2 }));
const preview = (rows, db = prisma) => previewImport({ db, actor: ADMIN, fileName: "legacy.xlsx", headers: HEADERS, rows, now: TODAY });
const commit = (p, rows, index, db = prisma) => commitChunk({ db, actor: ADMIN, importId: p.importId, chunkIndex: index, rows: chunkRows(rows, p.chunkSize)[index], now: TODAY });
async function commitAll(p, rows, db = prisma) {
    const chunks = [];
    for (let index = 0; index < p.chunkCount; index++) chunks.push(await commit(p, rows, index, db));
    return chunks;
}
async function importRows(rows) {
    const p = await preview(rows);
    const chunks = await commitAll(p, rows);
    await finishImport({ db: prisma, actor: ADMIN, importId: p.importId });
    return { p, chunks, importId: p.importId };
}
const ledgerOf = (importId) => prisma.candidateImportChange.findMany({ where: { importId }, orderBy: [{ chunkIndex: "asc" }, { entityType: "asc" }, { entityKey: "asc" }, { op: "asc" }] });
const of = (entries, type, op = null) => entries.filter((e) => e.entityType === type && (op === null || e.op === op));
const candidateByPassport = (i) => prisma.candidate.findUnique({ where: { passportId: passportOf(i) } });
const assessed = async (importId) => Object.fromEntries((await assessImportLedger({ db: prisma, importId })).entries.map((e) => [`${e.entityType}|${e.entityKey}|${e.op}`, e]));
const stateOf = (map, type, key, op) => map[`${type}|${key}|${op}`];

async function register(i, extra = {}) {
    const { values, errors } = parseCandidateBody({
        passportId: passportOf(i), surname: `SYNTHSURNAME${i}`, otherNames: `SYNTH GIVEN ${i}`, nic: `${710000000 + i}V`, whatsappNumber: `075${pad(i, 7)}`, jobTypes: ["PLASTER"], ...extra,
    }, { creating: true });
    assert.equal(errors, undefined);
    return createCandidate({ db: prisma, values, actor: ADMIN });
}
const addDocument = (passportId) => prisma.document.create({
    data: {
        documentId: randomUUID(), passportId, documentType: "PASSPORT", originalFilename: "file.pdf", storedFilename: "file.pdf",
        storagePath: `clients/${passportId}/${randomUUID()}.pdf`, receivedDate: new Date(), processingStatus: "STORED", verificationStatus: "VERIFIED",
    },
});

// A database client whose transactions run the work, then fail before commit: nothing may survive.
const rollingBackAfterWork = () => new Proxy(prisma, {
    get(target, prop) {
        if (prop === "$transaction") return (fn, options) => target.$transaction(async (tx) => { await fn(tx); throw new Error("synthetic failure after the work, before commit"); }, options);
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
    },
});
// A client whose transactions fail candidate.createMany for a batch holding `passport` (null = any batch), `times` times.
function withFailingCreate(passport, { times = Infinity } = {}) {
    let failures = 0;
    const wrapTx = (tx) => new Proxy(tx, {
        get(target, prop) {
            if (prop === "candidate") {
                return new Proxy(target.candidate, {
                    get(model, method) {
                        if (method === "createMany") {
                            return async (args) => {
                                if (failures < times && (passport === null || args.data.some((d) => d.passportId === passport))) {
                                    failures++;
                                    throw Object.assign(new Error("synthetic constraint failure"), { code: "P2002", meta: { target: ["nic"] } });
                                }
                                return model.createMany(args);
                            };
                        }
                        const value = model[method];
                        return typeof value === "function" ? value.bind(model) : value;
                    },
                });
            }
            const value = target[prop];
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    return new Proxy(prisma, {
        get(target, prop) {
            if (prop === "$transaction") return (fn, options) => target.$transaction((tx) => fn(wrapTx(tx)), options);
            const value = target[prop];
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

// ---------------------------------------------------------------- values and hashes (pure)

describe("ledger values: one canonical form, hashed when personal", () => {
    test("canonicalValue: the same text for a Date from the database and the date text the import wrote; numbers; booleans; blanks", () => {
        assert.equal(canonicalValue(new Date("1990-03-05T00:00:00.000Z")), "1990-03-05");
        assert.equal(canonicalValue("1990-03-05"), "1990-03-05");
        assert.equal(canonicalValue(new Date("2026-11-04T06:00:00.123Z")), "2026-11-04T06:00:00.123Z");
        assert.equal(canonicalValue(70), "70");
        assert.equal(canonicalValue(true), "true");
        for (const blank of [null, undefined, ""]) assert.equal(canonicalValue(blank), "");
    });

    test("digestOf is stable, differs per field and per value, and is a sha256 hex", () => {
        assert.match(digestOf("address", "1 Road"), /^[0-9a-f]{64}$/);
        assert.equal(digestOf("address", "1 Road"), digestOf("address", "1 Road"));
        assert.notEqual(digestOf("address", "1 Road"), digestOf("placeOfBirth", "1 Road"));
        assert.notEqual(digestOf("address", "1 Road"), digestOf("address", "2 Road"));
    });

    test("ledgerValue: a blank stays a blank, a personal value becomes { h }, a non-personal one is kept (dates as ISO text)", () => {
        assert.equal(ledgerValue("address", null, { hash: true }), null);
        assert.equal(ledgerValue("address", "", { hash: true }), "");
        assert.deepEqual(ledgerValue("address", "1 Road", { hash: true }), { h: digestOf("address", "1 Road") });
        assert.equal(ledgerValue("completed", true, { hash: false }), true);
        assert.equal(ledgerValue("completedAt", new Date("2026-11-04T06:00:00.000Z"), { hash: false }), "2026-11-04T06:00:00.000Z");
        assert.equal(ledgerValue("testDate", new Date("2026-07-11T00:00:00.000Z"), { hash: false }), "2026-07-11", "a date, not a timestamp");
    });

    test("matchesWritten compares the CURRENT value with what was written, hashed or not", () => {
        const hashed = { before: null, after: { h: digestOf("address", "1 Road") } };
        assert.equal(matchesWritten("address", "1 Road", hashed), true);
        assert.equal(matchesWritten("address", "2 Road", hashed), false);
        assert.equal(matchesWritten("address", null, hashed), false);
        assert.equal(matchesWritten("completed", true, { before: false, after: true }), true);
        assert.equal(matchesWritten("completed", false, { before: false, after: true }), false);
    });
});

// ---------------------------------------------------------------- what is recorded

describe("new candidates: created by the import", () => {
    test("one CREATE entry per candidate (and its details), by internal unique_id, with the row number, audit ids and the rollback action", async () => {
        const rows = renumber([row(1, 3100), row(2, 3101)]);
        const { importId } = await importRows(rows);
        const entries = await ledgerOf(importId);
        const candidates = of(entries, E.CANDIDATE);
        assert.equal(candidates.length, 2);
        for (const [k, entry] of candidates.entries()) {
            const candidate = await candidateByPassport(k + 1);
            assert.equal(entry.entityKey, candidate.uniqueId);
            assert.equal(entry.candidateUniqueId, candidate.uniqueId);
            assert.deepEqual([entry.op, entry.preExisting, entry.rollbackAction, entry.status], [LEDGER_OP.CREATE, false, ROLLBACK_ACTION.DELETE_IF_UNCHANGED, "APPLIED"]);
            assert.equal(entry.rowNumber, k + 2);
            assert.equal(entry.chunkIndex, 0);
        }
        assert.equal(of(entries, E.DETAILS, LEDGER_OP.CREATE).length, 2, "the details row the import created is recorded too");
        // The audit rows written for the change are named, and they are this import's.
        for (const entry of candidates) {
            const audits = await prisma.auditLog.findMany({ where: { auditId: { in: entry.auditIds } } });
            assert.equal(audits.length, entry.auditIds.length);
            assert.ok(audits.length > 0 && audits.every((a) => a.reason.includes(importId)));
        }
    });

    test("previous and new values: before is the blank that was there, after is a hash; no personal data anywhere in the ledger", async () => {
        const { importId } = await importRows(renumber([row(1, 3100)]));
        const entries = await ledgerOf(importId);
        const [entry] = of(entries, E.CANDIDATE);
        assert.ok(Object.keys(entry.changes).length >= 5);
        for (const [field, change] of Object.entries(entry.changes)) {
            assert.equal(change.before, null, `${field}: nothing was there`);
            assert.match(change.after.h, /^[0-9a-f]{64}$/, `${field} is a hash`);
        }
        const text = JSON.stringify(entries);
        for (const secret of SECRETS(1)) assert.ok(!text.includes(secret), `the ledger must not hold ${secret.slice(0, 4)}…`);
    });

    test("every recorded value still matches the database (the check a rollback relies on): hashes and clear values alike", async () => {
        const { importId } = await importRows(renumber([row(1, 3100, "11.07.2026", { "VISA STATUS": "Submit" })]));
        const entries = await ledgerOf(importId);
        const candidate = await candidateByPassport(1);
        const details = await prisma.candidateAdditionalDetails.findUnique({ where: { passportId: passportOf(1) } });
        for (const entry of of(entries, E.CANDIDATE)) for (const [field, change] of Object.entries(entry.changes)) assert.ok(matchesWritten(field, candidate[field], change), `candidate.${field}`);
        for (const entry of of(entries, E.DETAILS)) for (const [field, change] of Object.entries(entry.changes)) assert.ok(matchesWritten(field, details[field], change), `details.${field}`);
        for (const entry of of(entries, E.STAGE)) {
            const [, stage] = entry.entityKey.split(":");
            const stored = await prisma.candidateStage.findUnique({ where: { passportId_stage: { passportId: passportOf(1), stage } } });
            for (const [field, change] of Object.entries(entry.changes)) assert.ok(matchesWritten(field, stored[field], change), `${stage}.${field}`);
        }
        const clean = await assessImportLedger({ db: prisma, importId });
        assert.deepEqual([clean.summary.conflicts, clean.summary.missing, clean.summary.eligible === clean.summary.total], [0, 0, true]);
    });

    test("allocation, test stage, visa stage and Departed are recorded; Departed is part of the candidate's own entry", async () => {
        const rows = renumber([row(1, 3100, "11.07.2026", { "VISA STATUS": "Submit" }), row(2, 3101, "11.07.2026", { "VISA STATUS": "Departed" })]);
        const { importId } = await importRows(rows);
        const entries = await ledgerOf(importId);
        const [one, two] = [await candidateByPassport(1), await candidateByPassport(2)];
        const stage = (c, name) => of(entries, E.STAGE).find((e) => e.entityKey === `${c.uniqueId}:${name}`);
        assert.equal(of(entries, E.ALLOCATION).length, 2);
        assert.deepEqual(of(entries, E.ALLOCATION)[0].changes.analystId, { before: null, after: "u-john" });
        assert.equal(stage(one, "TEST_DETAILS").op, LEDGER_OP.CREATE);
        assert.equal(stage(one, "TEST_DETAILS").changes.testResult.after, "PASS");
        assert.equal(stage(one, "VISA_SUBMISSION").changes.completed.after, true);
        assert.equal(stage(two, "VISA_SUBMISSION"), undefined);
        const departed = of(entries, E.CANDIDATE).find((e) => e.entityKey === two.uniqueId);
        assert.ok(departed.changes.departedAt, "departedAt is in the candidate's CREATE entry");
        assert.equal(of(entries, E.CANDIDATE, LEDGER_OP.FILL).length, 0, "no separate entry for it");
    });

    test("Client, Agent and their link the import made are recorded, with a hashed name", async () => {
        const { importId } = await importRows(renumber([row(1, 3100), row(2, 3101)]));
        const entries = await ledgerOf(importId);
        const [client] = await prisma.client.findMany();
        const [agent] = await prisma.agent.findMany();
        assert.deepEqual(of(entries, E.CLIENT).map((e) => [e.entityKey, e.op]), [[client.id, LEDGER_OP.CREATE]], "created once, for two rows");
        assert.deepEqual(of(entries, E.AGENT).map((e) => [e.entityKey, e.op]), [[agent.id, LEDGER_OP.CREATE]]);
        assert.deepEqual(of(entries, E.AGENT_CLIENT).map((e) => [e.entityKey, e.op]), [[`${agent.id}:${client.id}`, LEDGER_OP.LINK]]);
        assert.ok(!JSON.stringify(entries).includes("Synth Builders"));
    });
});

describe("existing candidates: filled by the import", () => {
    test("an existing candidate gets a FILL entry under its own unique_id: only the blanks filled, before blank, no CREATE entry", async () => {
        await register(1);
        const existing = await candidateByPassport(1);
        const { importId, chunks } = await importRows(renumber([row(1, 3100)]));
        assert.equal(chunks[0].counts.filled, 1);
        const entries = await ledgerOf(importId);
        assert.equal(of(entries, E.CANDIDATE, LEDGER_OP.CREATE).length, 0, "the candidate existed before the import");
        const [fill] = of(entries, E.CANDIDATE, LEDGER_OP.FILL);
        assert.equal(fill.entityKey, existing.uniqueId, "the existing candidate's own unique_id");
        assert.deepEqual([fill.preExisting, fill.rollbackAction], [true, ROLLBACK_ACTION.CLEAR_IF_UNCHANGED]);
        assert.ok(fill.changes.address, "a blank was filled");
        assert.ok(!fill.changes.firstName && !fill.changes.nic, "values the candidate already had are not touched or recorded");
        for (const change of Object.values(fill.changes)) assert.ok(change.before === null || change.before === "", "only blanks are filled");
        for (const [field, change] of Object.entries(fill.changes)) assert.ok(matchesWritten(field, (await candidateByPassport(1))[field], change), field);
    });

    test("an existing candidate with nothing to fill is not recorded", async () => {
        await importRows(renumber([row(1, 3100)]));
        const second = await importRows(renumber([row(1, 3100)]));
        assert.equal(second.chunks[0].counts.noChange, 1);
        assert.equal((await ledgerOf(second.importId)).filter((e) => e.entityType === E.CANDIDATE).length, 0);
    });

    test("an existing Client and Agent are reused, never recorded; only the blank registration number the import filled is", async () => {
        const agent = await prisma.agent.create({ data: { name: "Synth Agency", countryCode: "RO" } });
        const client = await prisma.client.create({ data: { name: "Synth Builders" } });
        await prisma.agentClient.create({ data: { agentId: agent.id, clientId: client.id } });
        const { importId } = await importRows(renumber([row(1, 3100, "11.07.2026", { "COMPANY NUMBER": "REG-000123" })]));
        const entries = await ledgerOf(importId);
        assert.equal(of(entries, E.AGENT).length + of(entries, E.AGENT_CLIENT).length + of(entries, E.CLIENT, LEDGER_OP.CREATE).length, 0);
        const [fill] = of(entries, E.CLIENT, LEDGER_OP.FILL);
        assert.equal(fill.entityKey, client.id);
        assert.deepEqual(Object.keys(fill.changes), ["registrationNumber"]);
        assert.equal(fill.changes.registrationNumber.after.h, digestOf("registrationNumber", "REG-000123"));
        assert.equal(fill.preExisting, true);
    });
});

describe("Jobs: created or reused, and who was put on them", () => {
    test("a new Job, its group row and each member are recorded: the Job is marked as created by this import", async () => {
        const { importId } = await importRows(renumber([row(1, 3100), row(2, 3101)]));
        const entries = await ledgerOf(importId);
        const [job] = await prisma.job.findMany();
        const [jobEntry] = of(entries, E.JOB);
        assert.deepEqual([jobEntry.entityKey, jobEntry.op, jobEntry.jobCreatedByImport, jobEntry.relatedJobId], [job.id, LEDGER_OP.CREATE, true, job.id]);
        assert.equal(jobEntry.changes.jobCode.after, "JOB-2026-071101");
        const [group] = await prisma.importJobGroup.findMany();
        assert.deepEqual([of(entries, E.JOB_GROUP)[0].entityKey, of(entries, E.JOB_GROUP)[0].changes.suffix.after], [group.id, "01"]);
        const members = of(entries, E.JOB_CANDIDATE);
        assert.equal(members.length, 2);
        for (const m of members) assert.deepEqual([m.op, m.relatedJobId, m.jobCreatedByImport, m.rollbackAction], [LEDGER_OP.CREATE, job.id, true, ROLLBACK_ACTION.DELETE_IF_UNCHANGED]);
        const uniqueIds = (await prisma.candidate.findMany({ select: { uniqueId: true } })).map((c) => c.uniqueId);
        assert.deepEqual(members.map((m) => m.entityKey).sort(), uniqueIds.map((u) => `${job.id}:${u}`).sort());
    });

    test("a Job that already existed is reused: members are recorded as joined (the Job not created by this import), the Job itself is not recorded", async () => {
        const first = await importRows(renumber([row(1, 3100), row(2, 3101)]));
        const second = await importRows(renumber([row(3, 3102), row(4, 3103)]));
        const entries = await ledgerOf(second.importId);
        assert.equal(of(entries, E.JOB).length + of(entries, E.JOB_GROUP).length, 0, "the Job belongs to the first import");
        const members = of(entries, E.JOB_CANDIDATE);
        assert.equal(members.length, 2);
        assert.ok(members.every((m) => m.jobCreatedByImport === false && m.relatedJobId));
        assert.equal(of(await ledgerOf(first.importId), E.JOB)[0].jobCreatedByImport, true);
    });

    test("one Job across chunks: members added in a later chunk still know that this import created the Job", async () => {
        const rows = renumber(Array.from({ length: IMPORT_CHUNK_SIZE + 20 }, (_, k) => row(k + 1, 3100 + (k % 90))));
        const { importId } = await importRows(rows);
        const entries = await ledgerOf(importId);
        assert.equal(of(entries, E.JOB).length, 1, "created once, in the first chunk");
        const members = of(entries, E.JOB_CANDIDATE);
        assert.equal(members.length, IMPORT_CHUNK_SIZE + 20);
        assert.deepEqual([...new Set(members.map((m) => m.chunkIndex))].sort(), [0, 1]);
        assert.ok(members.every((m) => m.jobCreatedByImport === true), "also the members of the second chunk");
    });

    test("a candidate who already existed and only joins a Job: the membership is recorded, the candidate is not (nothing was filled)", async () => {
        await register(5);
        const existing = await candidateByPassport(5);
        const nothingElse = { ADDRESS: "", "BIRTH DATE": "", "SHIRT SIZE": "", "FATHER NAME": "" };
        const { importId } = await importRows(renumber([row(5, 3100, "11.07.2026", nothingElse)]));
        const entries = await ledgerOf(importId);
        const [job] = await prisma.job.findMany();
        assert.equal(of(entries, E.CANDIDATE, LEDGER_OP.CREATE).length, 0, "the candidate existed");
        assert.equal(of(entries, E.CANDIDATE).filter((e) => e.entityKey === existing.uniqueId && Object.keys(e.changes).some((f) => f === "address")).length, 0);
        const [member] = of(entries, E.JOB_CANDIDATE);
        assert.deepEqual([member.entityKey, member.relatedJobId, member.jobCreatedByImport, member.op], [`${job.id}:${existing.uniqueId}`, job.id, true, LEDGER_OP.CREATE]);
    });

    test("the existing candidate read for the ledger never reaches the preview (no personal data in the response)", async () => {
        await register(6);
        const p = await preview(renumber([row(6, 3100)]));
        const text = JSON.stringify(p);
        for (const secret of SECRETS(6)) assert.ok(!text.includes(secret), `the preview must not contain ${secret.slice(0, 4)}…`);
        assert.ok(!text.includes('"prior"'));
    });
});

// ---------------------------------------------------------------- chunks and transactions

describe("several 100-row chunks", () => {
    test("every chunk's entries carry its chunk index; one CANDIDATE entry per candidate; row numbers are the sheet's", async () => {
        const rows = renumber(Array.from({ length: 250 }, (_, k) => row(k + 1, null)));
        const { importId, chunks } = await importRows(rows);
        assert.equal(chunks.length, 3);
        const entries = of(await ledgerOf(importId), E.CANDIDATE);
        assert.equal(entries.length, 250);
        const perChunk = (i) => entries.filter((e) => e.chunkIndex === i).length;
        assert.deepEqual([perChunk(0), perChunk(1), perChunk(2)], [100, 100, 50]);
        assert.equal(new Set(entries.map((e) => e.entityKey)).size, 250, "no candidate twice");
        assert.deepEqual(entries.map((e) => e.rowNumber).sort((a, b) => a - b), rows.map((r) => r.rowNumber));
        assert.equal(await prisma.candidate.count(), 250);
    });
});

describe("transactions: the ledger is atomic with the chunk", () => {
    test("a chunk that fails after all its work (before commit) leaves no candidate and no ledger entry, anywhere", async () => {
        const rows = renumber([row(1, 3100), row(2, 3101)]);
        const p = await preview(rows);
        await assert.rejects(commit(p, rows, 0, rollingBackAfterWork()));
        assert.equal(await prisma.candidate.count(), 0);
        assert.equal(await prisma.candidateImportChange.count(), 0);
        assert.equal(await prisma.job.count(), 0);
        assert.deepEqual((await prisma.candidateImport.findUnique({ where: { importId: p.importId } })).chunkResults, {});
    });

    test("a whole chunk that fails once and is retried row by row: exactly one entry per candidate that exists", async () => {
        const rows = renumber([row(1, 3100), row(2, 3101), row(3, 3102)]);
        const p = await preview(rows);
        const result = await commit(p, rows, 0, withFailingCreate(null, { times: 1 }));
        assert.equal(result.status, "COMMITTED");
        const candidates = await prisma.candidate.findMany({ select: { uniqueId: true } });
        const entries = of(await ledgerOf(p.importId), E.CANDIDATE);
        assert.equal(candidates.length, 3);
        assert.deepEqual(entries.map((e) => e.entityKey).sort(), candidates.map((c) => c.uniqueId).sort());
    });

    test("one bad row: its chunk's other rows are recorded, the failed row has no candidate and no entry", async () => {
        const rows = renumber([row(1, 3100), row(2, 3101), row(3, 3102)]);
        const p = await preview(rows);
        const result = await commit(p, rows, 0, withFailingCreate(passportOf(2)));
        assert.equal(result.status, "PARTIAL");
        assert.equal(await candidateByPassport(2), null);
        const entries = of(await ledgerOf(p.importId), E.CANDIDATE);
        assert.equal(entries.length, 2);
        assert.deepEqual(entries.map((e) => e.rowNumber).sort(), [2, 4]);
    });

    test("earlier committed chunks stay traceable when a later chunk fails", async () => {
        const rows = renumber(Array.from({ length: IMPORT_CHUNK_SIZE + 5 }, (_, k) => row(k + 1, null)));
        const p = await preview(rows);
        await commit(p, rows, 0);
        await assert.rejects(commit(p, rows, 1, rollingBackAfterWork()));
        const entries = of(await ledgerOf(p.importId), E.CANDIDATE);
        assert.equal(entries.length, IMPORT_CHUNK_SIZE);
        assert.ok(entries.every((e) => e.chunkIndex === 0));
        assert.equal(await prisma.candidate.count(), IMPORT_CHUNK_SIZE);
    });
});

describe("retries never record a change twice", () => {
    test("the same chunk sent again is answered from its result: the ledger is unchanged", async () => {
        const rows = renumber([row(1, 3100), row(2, 3101)]);
        const p = await preview(rows);
        await commit(p, rows, 0);
        const before = await ledgerOf(p.importId);
        const again = await commit(p, rows, 0);
        assert.equal(again.alreadyCommitted, true);
        const after = await ledgerOf(p.importId);
        assert.deepEqual(after.map((e) => e.changeId), before.map((e) => e.changeId));
    });

    test("a PARTIAL chunk retried: the row that failed is now recorded once, the earlier rows' entries are not repeated", async () => {
        const rows = renumber([row(1, 3100), row(2, 3101), row(3, 3102)]);
        const p = await preview(rows);
        assert.equal((await commit(p, rows, 0, withFailingCreate(passportOf(2)))).status, "PARTIAL");
        const first = await ledgerOf(p.importId);
        assert.equal(of(first, E.CANDIDATE).length, 2);
        const retried = await commit(p, rows, 0);
        assert.equal(retried.status, "COMMITTED");
        const entries = await ledgerOf(p.importId);
        const candidates = of(entries, E.CANDIDATE);
        assert.equal(candidates.length, 3);
        assert.equal(new Set(candidates.map((e) => e.entityKey)).size, 3);
        for (const old of first) assert.ok(entries.some((e) => e.changeId === old.changeId), "an earlier entry is kept as it was");
        assert.equal(await prisma.candidate.count(), 3);
    });

    test("the same entry flushed twice is recorded once; the database refuses a duplicate even by hand", async () => {
        const rows = renumber([row(1, 3100)]);
        const p = await preview(rows);
        const entry = { entityType: E.CANDIDATE, entityKey: "9001", candidateUniqueId: "9001", op: LEDGER_OP.CREATE, rowNumber: 2, changes: { address: { before: null, after: { h: digestOf("address", "x") } } } };
        const flushOnce = async () => {
            const ledger = createLedger({ importId: p.importId, chunkIndex: 0 });
            ledger.add(entry);
            return prisma.$transaction((tx) => ledger.flush(tx));
        };
        assert.equal(await flushOnce(), 1);
        assert.equal(await flushOnce(), 0, "skipDuplicates");
        assert.equal(await prisma.candidateImportChange.count({ where: { importId: p.importId } }), 1);
        const [stored] = await ledgerOf(p.importId);
        await assert.rejects(prisma.candidateImportChange.create({ data: { ...stored, changeId: randomUUID() } }), (error) => error.code === "P2002");
        // A different change to the same entity (other fields) is a different entry.
        const other = createLedger({ importId: p.importId, chunkIndex: 0 });
        other.add({ ...entry, changes: { placeOfBirth: { before: null, after: { h: digestOf("placeOfBirth", "y") } } } });
        assert.equal(await prisma.$transaction((tx) => other.flush(tx)), 1);
    });

    test("the same entity changed twice inside one chunk is one entry holding both changes", () => {
        const ledger = createLedger({ importId: randomUUID(), chunkIndex: 0 });
        ledger.registerCandidate("N1", "0001");
        ledger.add({ entityType: E.CANDIDATE, entityKey: "0001", candidateUniqueId: "0001", op: LEDGER_OP.CREATE, changes: { a: { before: null, after: 1 } } });
        ledger.addCandidateFields("n1", { changes: { b: { before: null, after: 2 } } });
        assert.equal(ledger.size, 1);
        assert.deepEqual(Object.keys(ledger.list()[0].changes).sort(), ["a", "b"]);
    });
});

describe("ownership: the ledger belongs to one import", () => {
    test("two imports touching the same candidate each hold their own entries; the second one's change is a conflict for the first", async () => {
        const first = await importRows(renumber([row(1, 3100)]));
        const candidate = await candidateByPassport(1);
        // The second import fills a field the first left blank (a different sheet).
        await prisma.candidate.update({ where: { passportId: passportOf(1) }, data: { placeOfBirth: null } });
        const second = await importRows(renumber([row(1, 3100, "11.07.2026", { ADDRESS: `${1} Synthetic Road` })]));
        const [a, b] = [await ledgerOf(first.importId), await ledgerOf(second.importId)];
        assert.equal(of(a, E.CANDIDATE, LEDGER_OP.CREATE)[0].entityKey, candidate.uniqueId);
        assert.ok(a.every((e) => e.importId === first.importId) && b.every((e) => e.importId === second.importId));
        assert.equal(of(b, E.CANDIDATE, LEDGER_OP.CREATE).length, 0, "the second import did not create the candidate");
    });

    test("a second import cannot start while the first is committing: its ledger stays empty", async () => {
        const rows = renumber(Array.from({ length: IMPORT_CHUNK_SIZE + 5 }, (_, k) => row(k + 1, null)));
        const p = await preview(rows);
        await commit(p, rows, 0);
        const other = renumber([row(500, null)]);
        const q = await preview(other);
        await assert.rejects(commit(q, other, 0), (error) => error.code === "IMPORT_IN_PROGRESS");
        assert.equal(await prisma.candidateImportChange.count({ where: { importId: q.importId } }), 0);
        assert.equal(await prisma.candidate.count({ where: { passportId: passportOf(500) } }), 0);
    });
});

// ---------------------------------------------------------------- rollback eligibility and conflicts (read-only)

describe("assessImportLedger: which entries could still be reversed, which conflict", () => {
    const importWithEverything = async () => {
        const rows = renumber([row(1, 3100, "11.07.2026", { "VISA STATUS": "Submit" }), row(2, 3101)]);
        const { importId } = await importRows(rows);
        const [one, two] = [await candidateByPassport(1), await candidateByPassport(2)];
        const [job] = await prisma.job.findMany();
        const [client] = await prisma.client.findMany();
        return { importId, one, two, job, client };
    };

    test("untouched since the import: every entry is eligible, none conflicts; the assessment writes nothing", async () => {
        const { importId } = await importWithEverything();
        const before = await ledgerOf(importId);
        const result = await assessImportLedger({ db: prisma, importId });
        assert.deepEqual([result.summary.conflicts, result.summary.missing, result.summary.alreadyReverted], [0, 0, 0]);
        assert.equal(result.summary.eligible, result.summary.total);
        assert.ok(result.summary.total >= 15);
        assert.deepEqual((await ledgerOf(importId)).map((e) => [e.changeId, e.status, e.revertedAt]), before.map((e) => [e.changeId, e.status, e.revertedAt]));
    });

    test("a value the import wrote was changed by someone: that candidate is a conflict, the other is not", async () => {
        const { importId, one, two } = await importWithEverything();
        await prisma.candidate.update({ where: { passportId: passportOf(1) }, data: { address: "Changed by a person" } });
        const map = await assessed(importId);
        const entry = stateOf(map, E.CANDIDATE, one.uniqueId, LEDGER_OP.CREATE);
        assert.equal(entry.state, ASSESSMENT.CONFLICT);
        assert.deepEqual(entry.reasons, ["FIELD_CHANGED:address"]);
        assert.equal(stateOf(map, E.CANDIDATE, two.uniqueId, LEDGER_OP.CREATE).state, ASSESSMENT.ELIGIBLE);
    });

    test("a document added to a candidate the import created blocks deleting it", async () => {
        const { importId, one } = await importWithEverything();
        await addDocument(passportOf(1));
        assert.deepEqual(stateOf(await assessed(importId), E.CANDIDATE, one.uniqueId, LEDGER_OP.CREATE).reasons, ["HAS_DOCUMENTS"]);
    });

    test("something recorded about the candidate after the import, by anything else, is a conflict", async () => {
        const { importId, one } = await importWithEverything();
        await prisma.auditLog.create({ data: { auditId: randomUUID(), adminId: "admin-ADMIN", action: "SOMETHING_ELSE", passportId: passportOf(1), previousStatus: "A", newStatus: "B", reason: "a person changed this" } });
        assert.deepEqual(stateOf(await assessed(importId), E.CANDIDATE, one.uniqueId, LEDGER_OP.CREATE).reasons, ["CHANGED_AFTER_IMPORT"]);
    });

    test("a stage edited afterwards, an allocation reassigned, a membership removed: each is a conflict of its own", async () => {
        const { importId, one, job } = await importWithEverything();
        await prisma.candidateStage.update({ where: { passportId_stage: { passportId: passportOf(1), stage: "TEST_DETAILS" } }, data: { testResult: "FAIL" } });
        await prisma.candidateAllocation.update({ where: { passportId: passportOf(1) }, data: { analystId: "u-anna" } });
        await prisma.jobCandidate.update({ where: { jobId_passportId: { jobId: job.id, passportId: passportOf(1) } }, data: { isActive: false } });
        const map = await assessed(importId);
        assert.deepEqual(stateOf(map, E.STAGE, `${one.uniqueId}:TEST_DETAILS`, LEDGER_OP.CREATE).reasons, ["FIELD_CHANGED:testResult"]);
        assert.deepEqual(stateOf(map, E.ALLOCATION, one.uniqueId, LEDGER_OP.CREATE).reasons, ["FIELD_CHANGED:analystId"]);
        assert.deepEqual(stateOf(map, E.JOB_CANDIDATE, `${job.id}:${one.uniqueId}`, LEDGER_OP.CREATE).reasons, ["MEMBERSHIP_CHANGED"]);
        assert.equal(stateOf(map, E.STAGE, `${one.uniqueId}:VISA_SUBMISSION`, LEDGER_OP.CREATE).state, ASSESSMENT.ELIGIBLE, "an untouched stage is still eligible");
    });

    test("a Job that someone else put a candidate on, and a Client that another Job uses, are not the import's to remove", async () => {
        const { importId, job, client } = await importWithEverything();
        const agent = await prisma.agent.findFirst();
        await register(900);
        await prisma.jobCandidate.create({ data: { jobId: job.id, passportId: passportOf(900), assignedBy: "admin-ADMIN" } });
        const type = await prisma.jobType.findFirst();
        await prisma.job.create({ data: { jobCode: "JOB-2026-990001", jobTypeId: type.id, clientId: client.id, responsibleAgentId: agent.id, countryCode: "RO", fromCountryCode: "RO", status: "PROCESSING", createdById: "admin-ADMIN" } });
        const map = await assessed(importId);
        assert.deepEqual(stateOf(map, E.JOB, job.id, LEDGER_OP.CREATE).reasons, ["HAS_OTHER_MEMBERS"]);
        assert.deepEqual(stateOf(map, E.CLIENT, client.id, LEDGER_OP.CREATE).reasons, ["HAS_OTHER_JOBS"]);
    });

    test("a Job the import created that was closed is a conflict", async () => {
        const { importId, job } = await importWithEverything();
        await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED", completedAt: new Date() } });
        assert.ok(stateOf(await assessed(importId), E.JOB, job.id, LEDGER_OP.CREATE).reasons.includes("JOB_STATUS_CHANGED"));
    });

    test("a deleted candidate is MISSING, with everything that went with it; an entry already reverted is reported as such", async () => {
        const { importId, one } = await importWithEverything();
        await prisma.candidate.delete({ where: { passportId: passportOf(1) } });
        const map = await assessed(importId);
        for (const key of [[E.CANDIDATE, one.uniqueId, LEDGER_OP.CREATE], [E.STAGE, `${one.uniqueId}:TEST_DETAILS`, LEDGER_OP.CREATE], [E.ALLOCATION, one.uniqueId, LEDGER_OP.CREATE]]) {
            assert.equal(stateOf(map, ...key).state, ASSESSMENT.MISSING, key.join(" "));
        }
        const [entry] = await prisma.candidateImportChange.findMany({ where: { importId, entityType: E.CLIENT } });
        await prisma.candidateImportChange.update({ where: { changeId: entry.changeId }, data: { status: "REVERTED", revertedAt: new Date() } });
        assert.equal(stateOf(await assessed(importId), E.CLIENT, entry.entityKey, LEDGER_OP.CREATE).state, ASSESSMENT.ALREADY_REVERTED);
    });

    test("an existing candidate the import only filled: a field changed afterwards is a conflict, the others are not", async () => {
        await register(1);
        const existing = await candidateByPassport(1);
        const { importId } = await importRows(renumber([row(1, 3100)]));
        await prisma.candidate.update({ where: { passportId: passportOf(1) }, data: { address: "Changed by a person" } });
        const entry = stateOf(await assessed(importId), E.CANDIDATE, existing.uniqueId, LEDGER_OP.FILL);
        assert.equal(entry.state, ASSESSMENT.CONFLICT);
        assert.deepEqual(entry.reasons, ["FIELD_CHANGED:address"]);
        assert.ok(!entry.reasons.some((r) => r.startsWith("HAS_")), "an existing candidate is never deleted, so no dependents matter");
    });
});
