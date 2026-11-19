// Jobs from the Google Sheet upload ONLY (manual Job creation, jobService.js nextJobCode, is untouched).
//
// Candidates are grouped by their INTERVIEW DATE and the hundreds block of their UNIQUE NUMBER:
//   block  = floor(uniqueNumber / 100)            3100..3199 -> 31, 3200..3299 -> 32
//   group  = (interview date, block)              one Job per group
//   code   = JOB-YYYY-MMDD + NN                   e.g. JOB-2026-071101
// NN (the suffix, 01-99) is given per date: on a date with no Job yet, the date's blocks in ascending
// order get 01, 02, 03 ... (3100, 3300, 3500 -> 01, 02, 03: the order, never the block's own number).
// Once created, a group is stored (import_job_group) and REUSED by every later upload: its Job and its
// suffix never change by themselves, and a suffix a user edited stays. A block that first appears on a
// date that already has Jobs gets the lowest unused suffix (reported, so it can be edited before the
// import). The full code is checked against EVERY job code, manual ones included.
//
// The preview builds the plan for the whole file (buildJobGroupPlan, stored in candidate_import.
// job_groups, editable: applySuffixEdits); each commit chunk applies it (executeJobGroups) inside its
// transaction, under a per-date advisory lock, so two imports never create the same group twice.
// Only candidates who passed are put on a Job: Test result PASS (the existing assignment rule), or a
// visa step (VISA STATUS Submit / Got Visa, or a visa stage already completed), which means the test
// was passed whatever the result cell says. The others are imported and reported. The Job's Client,
// responsible Agent and Job Types come from the group's COMPANY, AGENT and Job roles (the one most of
// its rows name; a row naming another is left off the Job, a tie gives no Job); an Agent with no
// country gives the Job the To Country RO.

import crypto from "node:crypto";

import { CandidateError } from "./candidateService.js";
import { candidateScope, isCandidateScoped } from "./candidateAccess.js";
import { findAgentsByKeys, findClientsByKeys } from "./candidateImportClassifier.js";
import { orgKey } from "./candidateImportNormalizers.js";
import { LEDGER_ENTITY, LEDGER_OP, changesOf } from "./candidateImportLedger.js";
import { describeIssue } from "./candidateImportIssues.js";

export const IMPORT_JOB_DEFAULT_COUNTRY = "RO";
export const GROUP_STATE = Object.freeze({ NEW: "NEW", EXISTING: "EXISTING", SKIPPED: "SKIPPED", ERROR: "ERROR" });
const PROCESSING = "PROCESSING";
const PASS = "PASS";

// ---------------------------------------------------------------- pure helpers

export const hundredsBlock = (uniqueNumber) => Math.floor(uniqueNumber / 100);
export const isoDayOf = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
export const jobGroupKey = (interviewDate, block) => `${isoDayOf(interviewDate)}|${block}`;
export const importJobCodePrefix = (interviewDate) => {
    const day = isoDayOf(interviewDate);
    return `JOB-${day.slice(0, 4)}-${day.slice(5, 7)}${day.slice(8, 10)}`;
};
export const importJobCode = (interviewDate, suffix) => `${importJobCodePrefix(interviewDate)}${suffix}`;
export const isValidSuffix = (suffix) => typeof suffix === "string" && /^[0-9]{2}$/.test(suffix) && suffix !== "00";
const formatSuffix = (n) => String(n).padStart(2, "0");
const ALL_SUFFIXES = Array.from({ length: 99 }, (_, i) => formatSuffix(i + 1));

// What a row tells about its Job group (candidateImportClassifier.js planRows): { key, interviewDate,
// block, pass, visaPass, passportId, companyKey, companyName, agentKey, agentName, jobRoles }.
// visaPass: the candidate has a visa step, so they are put on the Job whatever their saved Test result.
export function jobMembership({ testDate, uniqueNumber, pass, visaPass = false, passportId, values }) {
    const block = hundredsBlock(uniqueNumber);
    return {
        key: jobGroupKey(testDate, block), interviewDate: isoDayOf(testDate), block, pass, visaPass: Boolean(visaPass), passportId,
        companyKey: values.company ? orgKey(values.company) : null, companyName: values.company ?? null,
        agentKey: values.agent ? orgKey(values.agent) : null, agentName: values.agent ?? null,
        jobRoles: typeof values.jobRole === "string" ? values.jobRole.split(",").map((r) => r.trim()).filter(Boolean) : [],
        hasOrg: false,
    };
}

// A row of a group that names a different company or agent than the group's own (the one most of its rows
// name, or an existing Job's Client): left off the Job, while the rest of the group still gets it. A row
// naming none is not odd.
export const isOddRow = (membership, group) => Boolean(
    (membership.companyKey && group?.companyKey && membership.companyKey !== group.companyKey)
    || (membership.agentKey && group?.agentKey && membership.agentKey !== group.agentKey),
);

// The key most rows name: [key, name, tie]. No key named: [null, null, false]. Two or more keys sharing the
// highest count: a tie (there is no way to tell which one is right).
function mostNamed(counts) {
    const ranked = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
    if (!ranked.length) return [null, null, false];
    if (ranked.length > 1 && ranked[1][1].count === ranked[0][1].count) return [null, null, true];
    return [ranked[0][0], ranked[0][1].name, false];
}

// ---------------------------------------------------------------- the plan (preview)

// What the database already has for the file's dates: the stored groups and every job code that
// starts with one of those dates' prefixes (a suffix whose code is taken is never proposed).
export async function loadJobGroupContext(db, dates) {
    if (!dates.length) return { existing: [], takenCodes: new Set() };
    const [existing, jobs] = await Promise.all([
        db.importJobGroup.findMany({
            where: { interviewDate: { in: dates.map((d) => new Date(`${d}T00:00:00.000Z`)) } },
            select: { interviewDate: true, hundredsBlock: true, suffix: true, jobId: true, job: { select: { jobCode: true, status: true, client: { select: { name: true } } } } },
        }),
        db.job.findMany({ where: { OR: dates.map((d) => ({ jobCode: { startsWith: importJobCodePrefix(d) } })) }, select: { jobCode: true } }),
    ]);
    return {
        existing: existing.map((g) => ({
            interviewDate: isoDayOf(g.interviewDate), block: g.hundredsBlock, suffix: g.suffix, jobId: g.jobId,
            jobCode: g.job.jobCode, jobStatus: g.job.status, clientName: g.job.client?.name ?? null,
        })),
        takenCodes: new Set(jobs.map((j) => j.jobCode)),
    };
}

// The groups of a file. plans: the classified rows (each with plan.job when it belongs to a group).
// Returns the groups, date then block ascending:
//   { key, interviewDate, block, from, to, prefix, suffix, jobCode, state, codes, candidates, passed,
//     companyKey, companyName, agentKey, agentName, jobRoles, jobId, existingJobCode, autoSuffix }
// state: EXISTING (the stored group's Job is reused), NEW (a Job is created), SKIPPED (no candidate
// passed: no Job), ERROR (the group's rows disagree, or no Client: no Job, nobody assigned).
export function buildJobGroupPlan(plans, { existing = [], takenCodes = new Set() } = {}) {
    const groups = new Map();
    const count = (map, key, name) => { if (key) map.set(key, { name, count: (map.get(key)?.count ?? 0) + 1 }); };
    for (const plan of plans) {
        if (!plan.job) continue;
        const m = plan.job;
        if (!groups.has(m.key)) {
            groups.set(m.key, {
                key: m.key, interviewDate: m.interviewDate, block: m.block, from: m.block * 100, to: m.block * 100 + 99,
                prefix: importJobCodePrefix(m.interviewDate), companies: new Map(), agents: new Map(), rows: [],
            });
        }
        const g = groups.get(m.key);
        g.rows.push(plan);
        count(g.companies, m.companyKey, m.companyName);
        count(g.agents, m.agentKey, m.agentName);
    }
    const stored = new Map(existing.map((e) => [jobGroupKey(e.interviewDate, e.block), e]));
    const result = [];
    for (const g of groups.values()) {
        const codes = [];
        const found = stored.get(g.key);
        // The group's company: an existing Job's Client, otherwise the one most rows name. Its agent: the one
        // most rows name. A row naming another is an odd row (isOddRow), left off the Job.
        let [companyKey, companyName, companyTie] = mostNamed(g.companies);
        if (found?.clientName) [companyKey, companyName, companyTie] = [orgKey(found.clientName), found.clientName, false];
        const [agentKey, agentName, agentTie] = mostNamed(g.agents);
        if (companyTie) codes.push("JOB_GROUP_COMPANY_CONFLICT");
        if (agentTie) codes.push("JOB_GROUP_AGENT_CONFLICT");
        // The rows that go on the Job decide it: an odd row never makes it fail or succeed.
        const members = g.rows.filter((plan) => !isOddRow(plan.job, { companyKey, agentKey }));
        g.candidates = members.length;
        g.passed = members.filter((plan) => plan.job.pass).length;
        g.jobRoles = new Set(members.flatMap((plan) => plan.job.jobRoles));
        g.hasOrg = members.some((plan) => plan.org);
        let state;
        if (found) {
            state = GROUP_STATE.EXISTING;
            if (found.jobStatus !== PROCESSING) codes.push("JOB_GROUP_JOB_CLOSED");
            if (codes.some((c) => c !== "JOB_GROUP_JOB_CLOSED")) state = GROUP_STATE.ERROR;
        } else if (codes.length) state = GROUP_STATE.ERROR;
        else if (!companyKey) { codes.push("JOB_GROUP_NO_COMPANY"); state = GROUP_STATE.ERROR; }
        else if (!g.hasOrg) { codes.push("JOB_GROUP_NO_CLIENT"); state = GROUP_STATE.ERROR; }
        else if (!g.jobRoles.size) { codes.push("JOB_GROUP_NO_JOB_TYPE"); state = GROUP_STATE.ERROR; }
        else if (!g.passed) { codes.push("JOB_GROUP_NONE_PASSED"); state = GROUP_STATE.SKIPPED; }
        else state = GROUP_STATE.NEW;
        result.push({
            key: g.key, interviewDate: g.interviewDate, block: g.block, from: g.from, to: g.to, prefix: g.prefix,
            suffix: found?.suffix ?? null, jobCode: found?.jobCode ?? null, state, codes, candidates: g.candidates, passed: g.passed,
            companyKey, companyName, agentKey, agentName, jobRoles: [...g.jobRoles],
            jobId: found?.jobId ?? null, existingJobCode: found?.jobCode ?? null, autoSuffix: null, edited: false,
        });
    }
    result.sort((a, b) => a.interviewDate.localeCompare(b.interviewDate) || a.block - b.block);

    // Suffixes for the NEW groups, date by date, ascending block order: the lowest suffix not used by a
    // stored group of that date and whose full code is not taken by any job.
    for (const date of new Set(result.map((g) => g.interviewDate))) {
        const ofDate = result.filter((g) => g.interviewDate === date);
        const used = new Set(existing.filter((e) => e.interviewDate === date).map((e) => e.suffix));
        const dateHadJobs = used.size > 0;
        for (const g of ofDate.filter((x) => x.state === GROUP_STATE.NEW)) {
            const suffix = ALL_SUFFIXES.find((s) => !used.has(s) && !takenCodes.has(importJobCode(date, s)));
            if (!suffix) { g.state = GROUP_STATE.ERROR; g.codes.push("JOB_GROUP_NO_SUFFIX_LEFT"); continue; }
            used.add(suffix);
            Object.assign(g, { suffix, autoSuffix: suffix, jobCode: importJobCode(date, suffix) });
            if (dateHadJobs) g.codes.push("JOB_GROUP_ADDED_LATER");
        }
    }
    return result;
}

// A user's suffix edits ({ [group key]: "05" }) on the stored plan: only NEW groups, exactly two digits
// (01-99), and every code of the plan must stay unique, also against existing job codes and the date's
// stored groups. Returns { groups } or { errors: [{ key, message }] }; nothing is applied on an error.
export function applySuffixEdits(groups, edits, { existing = [], takenCodes = new Set() } = {}) {
    const errors = [];
    const next = groups.map((g) => ({ ...g, codes: [...g.codes] }));
    const byKey = new Map(next.map((g) => [g.key, g]));
    for (const [key, suffix] of Object.entries(edits ?? {})) {
        const g = byKey.get(key);
        if (!g) { errors.push({ key, message: "This Job group is not in the upload." }); continue; }
        if (g.state !== GROUP_STATE.NEW) { errors.push({ key, message: "Only a new Job's last two digits can be chosen here; an existing Job keeps its ID (edit it on the Job)." }); continue; }
        if (!isValidSuffix(suffix)) { errors.push({ key, message: "Enter exactly two digits, 01 to 99." }); continue; }
        Object.assign(g, { suffix, jobCode: importJobCode(g.interviewDate, suffix), edited: suffix !== g.autoSuffix });
    }
    const storedSuffix = new Set(existing.map((e) => `${e.interviewDate}|${e.suffix}`));
    const seen = new Map();
    for (const g of next.filter((x) => x.state === GROUP_STATE.NEW)) {
        const original = groups.find((x) => x.key === g.key);
        const changed = original.suffix !== g.suffix;
        if (seen.has(g.jobCode)) errors.push({ key: g.key, message: `${g.jobCode} is already used by another group of this upload.` });
        else if (changed && (takenCodes.has(g.jobCode) || storedSuffix.has(`${g.interviewDate}|${g.suffix}`))) errors.push({ key: g.key, message: `${g.jobCode} already exists. Choose other digits.` });
        seen.set(g.jobCode, g.key);
    }
    return errors.length ? { errors } : { groups: next };
}

// What the browser gets (no candidate data: dates, ranges, counts, Client / Agent names).
export const jobGroupView = (g) => ({
    key: g.key, interviewDate: g.interviewDate, from: g.from, to: g.to, prefix: g.prefix, suffix: g.suffix, jobCode: g.jobCode,
    state: g.state, codes: g.codes, candidates: g.candidates, passed: g.passed, clientName: g.companyName, agentName: g.agentName,
    existingJobCode: g.existingJobCode, edited: Boolean(g.edited), messages: g.codes.map((code) => describeIssue({ code }).message),
});

// How many rows the import will put on a Job (a candidate who passed, of a group that gets or has one, and
// not an odd row of it).
export const plannedJobMembers = (plans, groups) => {
    const usable = new Map(groups.filter((g) => g.state === GROUP_STATE.NEW || g.state === GROUP_STATE.EXISTING).map((g) => [g.key, g]));
    return plans.filter((p) => p.job?.pass && usable.has(p.job.key) && !isOddRow(p.job, usable.get(p.job.key))).length;
};

// Rows of a group that gets no Job say so (their own issue list, the "Rows to review" table).
export function noteGroupOutcomes(plans, groups) {
    const byKey = new Map(groups.map((g) => [g.key, g]));
    for (const plan of plans) {
        if (!plan.job) continue;
        const g = byKey.get(plan.job.key);
        const add = (code, field = "uniqueNumber") => {
            if (!plan.codes.includes(code)) plan.codes.push(code);
            if (!plan.issues.some((i) => i.code === code)) plan.issues.push({ field, code });
        };
        if (!g || g.state === GROUP_STATE.ERROR || g.state === GROUP_STATE.SKIPPED) add("JOB_GROUP_NOT_CREATED");
        else if (isOddRow(plan.job, g)) add("JOB_GROUP_ROW_MISMATCH", "company");
        else if (g.codes.includes("JOB_GROUP_JOB_CLOSED")) add("JOB_GROUP_JOB_CLOSED");
    }
}

// ---------------------------------------------------------------- commit (inside the chunk transaction)

const auditRow = (actor, data) => ({ auditId: crypto.randomUUID(), adminId: actor.adminId, ...data });

// The Client and responsible Agent of a NEW group's Job, read inside the transaction (an earlier chunk
// or this one created them). null when the group can't have a Job.
async function resolveOrg(tx, group) {
    const [client] = (await findClientsByKeys(tx, [group.companyKey])).filter((c) => c.isActive);
    if (!client || !client.agentIds.length) return null;
    const linked = await tx.agent.findMany({ where: { id: { in: client.agentIds }, isActive: true }, select: { id: true, name: true, countryCode: true } });
    let agent = null;
    if (group.agentKey) agent = linked.find((a) => orgKey(a.name) === group.agentKey) ?? null;
    else if (linked.length === 1) [agent] = linked;
    return agent ? { client, agent } : null;
}

async function createGroupJob(tx, group, { actor, importId, audits }) {
    const jobCode = importJobCode(group.interviewDate, group.suffix);
    if (await tx.job.findUnique({ where: { jobCode }, select: { id: true } })) return { code: "JOB_CODE_TAKEN" };
    const org = await resolveOrg(tx, group);
    if (!org) return { code: "JOB_GROUP_NO_CLIENT" };
    const types = await tx.jobType.findMany({ where: { name: { in: group.jobRoles, mode: "insensitive" }, isActive: true }, select: { id: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
    if (!types.length) return { code: "JOB_GROUP_NO_JOB_TYPE" };
    const countryCode = org.agent.countryCode ?? IMPORT_JOB_DEFAULT_COUNTRY;
    const job = await tx.job.create({
        data: {
            jobCode, jobTypeId: types[0].id, clientId: org.client.id, responsibleAgentId: org.agent.id, countryCode,
            fromCountryCode: IMPORT_JOB_DEFAULT_COUNTRY, status: PROCESSING, createdById: actor.adminId,
            jobTypes: { create: types.map((t) => ({ jobTypeId: t.id })) },
        },
        select: { id: true, jobCode: true, status: true },
    });
    const groupRow = await tx.importJobGroup.create({ data: { interviewDate: new Date(`${group.interviewDate}T00:00:00.000Z`), hundredsBlock: group.block, suffix: group.suffix, jobId: job.id }, select: { id: true } });
    const audit = auditRow(actor, {
        action: "CREATE_JOB", previousStatus: "NONE", newStatus: PROCESSING,
        reason: `Job ${job.jobCode} created by a sheet upload (bulk import ${importId}): Interview Date ${group.interviewDate}, Unique Numbers ${group.from}-${group.to}`,
        newValue: JSON.stringify({ jobId: job.id, jobCode: job.jobCode, clientId: org.client.id, jobTypeIds: types.map((t) => t.id), responsibleAgentId: org.agent.id, countryCode, countryDefaulted: !org.agent.countryCode, importId }),
    });
    audits.push(audit);
    // What the change ledger records about the new Job and its group row (internal ids and codes only).
    return {
        job, groupId: groupRow.id, auditId: audit.auditId,
        fields: { jobCode: job.jobCode, jobTypeId: types[0].id, clientId: org.client.id, responsibleAgentId: org.agent.id, countryCode, status: PROCESSING },
    };
}

// The chunk's rows put on their group's Job. storedGroups: the import's plan (candidate_import.job_groups).
// Adds codes to the plans it can't place, and effects { jobCreated, jobAssigned }. Batched per group.
export async function executeJobGroups(tx, plans, storedGroups, { actor, importId, audits, effects, ledger = null }) {
    const byKey = new Map((storedGroups ?? []).map((g) => [g.key, g]));
    const members = new Map();
    for (const plan of plans) {
        if (!plan.job) continue;
        if (!members.has(plan.job.key)) members.set(plan.job.key, []);
        members.get(plan.job.key).push(plan);
    }
    const note = (plan, code) => { if (!plan.codes.includes(code)) plan.codes.push(code); };
    for (const key of [...members.keys()].sort()) {
        const group = byKey.get(key);
        if (!group || (group.state !== GROUP_STATE.NEW && group.state !== GROUP_STATE.EXISTING)) { members.get(key).forEach((p) => note(p, "JOB_GROUP_NOT_CREATED")); continue; }
        // A row naming another company or agent than the group's is left off the Job (the rest still get it).
        const rows = members.get(key).filter((p) => {
            if (!isOddRow(p.job, group)) return true;
            note(p, "JOB_GROUP_ROW_MISMATCH");
            return false;
        });
        if (!rows.length) continue;
        // One date at a time across every import: its groups and suffixes are read and written alone.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`import_job_group:${group.interviewDate}`}))`;
        let stored = await tx.importJobGroup.findUnique({
            where: { interviewDate_hundredsBlock: { interviewDate: new Date(`${group.interviewDate}T00:00:00.000Z`), hundredsBlock: group.block } },
            select: { job: { select: { id: true, jobCode: true, status: true } } },
        });
        let job = stored?.job ?? null;
        // Whether THIS import made the Job (in this chunk, or in an earlier chunk of it): a rollback may delete only those.
        let jobCreatedByImport = false;
        if (!job) {
            const created = await createGroupJob(tx, group, { actor, importId, audits });
            if (!created.job) { rows.forEach((p) => note(p, created.code)); continue; }
            job = created.job;
            jobCreatedByImport = true;
            effects.get(rows[0].rowNumber).jobCreated = 1;
            ledger?.add({
                entityType: LEDGER_ENTITY.JOB, entityKey: job.id, op: LEDGER_OP.CREATE, rowNumber: rows[0].rowNumber, relatedJobId: job.id, jobCreatedByImport: true,
                changes: changesOf(created.fields, null, { hash: false }), auditIds: [created.auditId],
            });
            ledger?.add({
                entityType: LEDGER_ENTITY.JOB_GROUP, entityKey: created.groupId, op: LEDGER_OP.CREATE, rowNumber: rows[0].rowNumber, relatedJobId: job.id, jobCreatedByImport: true,
                changes: changesOf({ interviewDate: group.interviewDate, hundredsBlock: group.block, suffix: group.suffix, jobId: job.id }, null, { hash: false }),
            });
        } else if (ledger && group.state === GROUP_STATE.NEW) {
            // The plan said this import creates the Job: an earlier chunk of it did (its ledger entry says so);
            // otherwise another import or a person made it first and it is not this import's to remove.
            jobCreatedByImport = Boolean(await tx.candidateImportChange.findFirst({ where: { importId, entityType: LEDGER_ENTITY.JOB, entityKey: job.id }, select: { changeId: true } }));
        }
        if (job.status !== PROCESSING) { rows.forEach((p) => note(p, "JOB_GROUP_JOB_CLOSED")); continue; }

        // Only a candidate whose SAVED Test result is PASS (the existing rule, read now: this chunk may
        // have just written it) or who has a visa step (plan.job.visaPass: they passed, whatever the saved
        // result says), and never one a user removed from this Job (that decision stays).
        const passports = [...new Set(rows.map((p) => p.job.passportId))];
        const [results, memberships] = await Promise.all([
            tx.candidateStage.findMany({ where: { passportId: { in: passports }, stage: "TEST_DETAILS" }, select: { passportId: true, testResult: true } }),
            tx.jobCandidate.findMany({ where: { jobId: job.id, passportId: { in: passports } }, select: { passportId: true, isActive: true } }),
        ]);
        const passed = new Set([
            ...results.filter((r) => r.testResult === PASS).map((r) => r.passportId),
            ...rows.filter((p) => p.job.visaPass).map((p) => p.job.passportId),
        ]);
        const already = new Map(memberships.map((m) => [m.passportId, m.isActive]));
        const toAdd = [];
        for (const plan of rows) {
            const id = plan.job.passportId;
            if (!passed.has(id)) note(plan, "NOT_PASSED_NO_JOB");
            else if (already.get(id) === false) note(plan, "JOB_MEMBER_REMOVED_KEPT");
            else if (already.get(id) !== true && !toAdd.includes(id)) { toAdd.push(id); effects.get(plan.rowNumber).jobAssigned = 1; }
        }
        if (!toAdd.length) continue;
        await tx.jobCandidate.createMany({ data: toAdd.map((passportId) => ({ jobId: job.id, passportId, assignedBy: actor.adminId, isActive: true })), skipDuplicates: true });
        const rowOf = new Map(rows.map((p) => [p.job.passportId, p.rowNumber]));
        toAdd.forEach((passportId) => {
            const audit = auditRow(actor, {
                action: "ADD_CANDIDATE_TO_JOB", passportId, previousStatus: "NOT_ASSIGNED", newStatus: "ASSIGNED",
                reason: `Assigned to ${job.jobCode} by a sheet upload (bulk import ${importId})`, newValue: JSON.stringify({ jobId: job.id, jobCode: job.jobCode }),
            });
            audits.push(audit);
            // The membership the import created (an existing one is never recorded, so never removed), with
            // the Job it belongs to and whether the import made that Job.
            const uniqueId = ledger?.uniqueIdOf(passportId);
            if (ledger && uniqueId) {
                ledger.add({
                    entityType: LEDGER_ENTITY.JOB_CANDIDATE, entityKey: `${job.id}:${uniqueId}`, candidateUniqueId: uniqueId, op: LEDGER_OP.CREATE, rowNumber: rowOf.get(passportId) ?? null,
                    relatedJobId: job.id, jobCreatedByImport, changes: changesOf({ isActive: true, assignedBy: actor.adminId }, null, { hash: false }), auditIds: [audit.auditId],
                });
            }
        });
    }
}

// ---------------------------------------------------------------- after the import: the last two digits

export const SUFFIX_EDITOR_ROLES = Object.freeze(["ADMIN", "JOB_HANDLER", "ANALYST"]); // OWNER via requireRole

// PATCH /api/admin/jobs/:jobId/import-suffix { suffix }: only a Job created by the sheet upload, only
// its last two digits. An Analyst only for a Job holding one of their candidates. Audited UPDATE_JOB.
export async function updateImportJobSuffix({ db, actor, jobId, suffix }) {
    if (!isValidSuffix(suffix)) throw new CandidateError(400, "INVALID_SUFFIX", "Enter exactly two digits, 01 to 99.");
    return db.$transaction(async (tx) => {
        const scope = isCandidateScoped(actor) ? { candidates: { some: { releasedAt: null, candidate: candidateScope(actor) } } } : {};
        const job = await tx.job.findFirst({ where: { id: jobId, ...scope }, select: { id: true, jobCode: true, importGroup: { select: { id: true, interviewDate: true, suffix: true } } } });
        if (!job) throw new CandidateError(404, "JOB_NOT_FOUND", "Job not found");
        if (!job.importGroup) throw new CandidateError(409, "NOT_AN_IMPORT_JOB", "Only a Job created by the sheet upload has editable last two digits.");
        const date = isoDayOf(job.importGroup.interviewDate);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`import_job_group:${date}`}))`;
        if (job.importGroup.suffix === suffix) return { jobId: job.id, jobCode: job.jobCode };
        const jobCode = importJobCode(date, suffix);
        const [codeTaken, suffixTaken] = await Promise.all([
            tx.job.findUnique({ where: { jobCode }, select: { id: true } }),
            tx.importJobGroup.findFirst({ where: { interviewDate: job.importGroup.interviewDate, suffix, NOT: { id: job.importGroup.id } }, select: { id: true } }),
        ]);
        if (codeTaken || suffixTaken) throw new CandidateError(409, "JOB_CODE_TAKEN", `${jobCode} already exists. Choose other digits.`);
        await tx.job.update({ where: { id: job.id }, data: { jobCode } });
        await tx.importJobGroup.update({ where: { id: job.importGroup.id }, data: { suffix } });
        await tx.auditLog.create({
            data: auditRow(actor, {
                action: "UPDATE_JOB", previousStatus: job.jobCode, newStatus: jobCode, reason: `Job ID changed from ${job.jobCode} to ${jobCode} (last two digits)`,
                previousValue: JSON.stringify({ jobId: job.id, jobCode: job.jobCode }), newValue: JSON.stringify({ jobId: job.id, jobCode }),
            }),
        });
        return { jobId: job.id, jobCode };
    });
}
