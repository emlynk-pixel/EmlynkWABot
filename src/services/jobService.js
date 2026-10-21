import crypto from "node:crypto";

import { CandidateError, TEST_RESULT_PASS, WORKFLOW_STATUS_SELECT, candidateWorkflowStatuses, listPagination, resolveCandidatePassportId } from "./candidateService.js";
import { candidateScope, isCandidateScoped } from "./candidateAccess.js";
import { JOB_SELECT, JOB_STATUS, jobSummaryView } from "./jobAssignmentReader.js";
import { clientName } from "../utils/clientName.js";
import { normalizeCountryCode } from "../utils/countries.js";

export { JOB_STATUS };

// Job Management (Admin > Jobs). Docs/JOB_MANAGEMENT_IMPLEMENTATION.md.
//
// A Job belongs to one Client (the employer), one Job Type and one responsible
// Agent. The Agent must be the Client's own Agent (checked on create and update). A
// candidate is assigned through job_candidate; at most ONE PROCESSING job per
// candidate (service check under row locks, and the partial unique index
// job_candidate_one_active_per_candidate as the database's own guarantee).
// COMPLETED / CANCELLED keep every assignment row (history) and release the
// candidates. Jobs are never deleted; reopening is not supported.
//
// Roles (the routes check them; the service applies the Analyst scope):
//   ADMIN, MANAGER   manage jobs and reference data
//   ANALYST          read-only, and only jobs holding a candidate allocated to them
//   REGISTRATION_DESK no access to the Jobs API

export const JOB_AUDIT_ACTION = Object.freeze({
    CREATE: "CREATE_JOB",
    UPDATE: "UPDATE_JOB",
    COMPLETE: "COMPLETE_JOB",
    CANCEL: "CANCEL_JOB",
    ADD_CANDIDATE: "ADD_CANDIDATE_TO_JOB",
    REMOVE_CANDIDATE: "REMOVE_CANDIDATE_FROM_JOB",
    CREATE_JOB_TYPE: "CREATE_JOB_TYPE",
    UPDATE_JOB_TYPE: "UPDATE_JOB_TYPE",
    ACTIVATE_JOB_TYPE: "ACTIVATE_JOB_TYPE",
    DEACTIVATE_JOB_TYPE: "DEACTIVATE_JOB_TYPE",
});

export const JOB_VIEWS = Object.freeze({ processing: JOB_STATUS.PROCESSING, completed: JOB_STATUS.COMPLETED, cancelled: JOB_STATUS.CANCELLED });
export const JOB_LIST_PAGE_SIZE = 50;
const MAX_VACANCIES = 100_000;
const MAX_NAME_LENGTH = 120;
const MAX_CANCEL_REASON_LENGTH = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;
const COMPANY_JOB_ID_PATTERN = /^[A-Z0-9][A-Z0-9 ._/#-]{0,39}$/;
const PASSPORT_ID_PATTERN = /^[A-Za-z0-9-]{1,20}$/;
// A new job's From Country unless the request names another (Romania).
export const DEFAULT_FROM_COUNTRY = "RO";
// The most candidates one New job request may assign (the vacancies never limit it).
export const MAX_CREATE_CANDIDATES = 500;

export const isValidJobIdParam = (value) => typeof value === "string" && UUID_PATTERN.test(value);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isUniqueViolation = (error) => error?.code === "P2002";
const iso = (value) => (value ? value.toISOString() : null);

// ---------------------------------------------------------------- parsing

function requiredId(body, field, errors) {
    const value = body[field];
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
        errors.push({ field, message: "must be an ID from the list" });
        return undefined;
    }
    return value.toLowerCase();
}

// The employer's Job ID: trimmed, inner spaces collapsed, English letters upper
// case; null / empty clears it. Letters, digits, space and . _ / # - only (no
// control characters), 1-40 characters. Returns undefined (and an error) when invalid.
export function normalizeCompanyJobId(value, errors, field = "companyJobId") {
    if (value === null || value === "") return null;
    // Control characters (tabs and line breaks too) are refused, not normalised away.
    const text = typeof value === "string" && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value.trim().replace(/ +/g, " ").toUpperCase() : null;
    if (text === null || !COMPANY_JOB_ID_PATTERN.test(text)) {
        errors.push({ field, message: "must be 1-40 characters: letters, digits, spaces and . _ / # -" });
        return undefined;
    }
    return text;
}

function parseVacancies(value, errors) {
    if (value === null || value === "") return null;
    if (!Number.isInteger(value) || value < 1 || value > MAX_VACANCIES) {
        errors.push({ field: "vacancies", message: `must be a whole number from 1 to ${MAX_VACANCIES}, or empty` });
        return undefined;
    }
    return value;
}

function parseFromCountry(value, errors) {
    const code = normalizeCountryCode(value);
    if (!code) {
        errors.push({ field: "fromCountryCode", message: "must be a 2-letter country code from the list (e.g. RO)" });
        return undefined;
    }
    return code;
}

// candidateIds: passport IDs to assign when the job is created (none, one or many; more than the
// vacancies is allowed). A repeated ID counts once. The service re-checks every rule.
function parseCandidateIds(value, errors) {
    if (!Array.isArray(value) || value.length > MAX_CREATE_CANDIDATES || value.some((id) => typeof id !== "string" || !PASSPORT_ID_PATTERN.test(id.trim()))) {
        errors.push({ field: "candidateIds", message: `must be a list of at most ${MAX_CREATE_CANDIDATES} passport IDs` });
        return undefined;
    }
    const seen = new Set();
    return value.map((id) => id.trim()).filter((id) => {
        const key = id.toUpperCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// GET /api/admin/jobs?view=processing|completed|cancelled&search=&page=
export function parseJobListQuery(query = {}) {
    const errors = [];
    const params = { view: "processing", page: 1, pageSize: JOB_LIST_PAGE_SIZE };
    const single = (field) => {
        const value = query[field];
        if (value === undefined || value === "") return undefined;
        if (typeof value !== "string") {
            errors.push({ field, message: "must be given once" });
            return undefined;
        }
        return value;
    };
    const view = single("view");
    if (view !== undefined) {
        if (Object.hasOwn(JOB_VIEWS, view)) params.view = view;
        else errors.push({ field: "view", message: `must be one of: ${Object.keys(JOB_VIEWS).join(", ")}` });
    }
    const page = single("page");
    if (page !== undefined) {
        if (/^\d{1,5}$/.test(page) && Number(page) >= 1) params.page = Number(page);
        else errors.push({ field: "page", message: "must be a whole number from 1 to 99999" });
    }
    const search = single("search");
    if (search !== undefined) {
        const trimmed = search.trim();
        if (trimmed.length > 100) errors.push({ field: "search", message: "must be at most 100 characters" });
        else if (trimmed) params.search = trimmed;
    }
    return errors.length ? { errors } : { params };
}

// POST /api/admin/jobs { jobTypeId, clientId, responsibleAgentId?, vacancies?, companyJobId?, fromCountryCode?, candidateIds? }
// responsibleAgentId must be one of the Client's Agents; it may be omitted only when the
// Client has exactly one (requireClientWithAgent). The To Country is never sent: it is
// the responsible Agent's country. fromCountryCode defaults to RO.
export function parseCreateJobBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const values = {
        jobTypeId: requiredId(body, "jobTypeId", errors),
        clientId: requiredId(body, "clientId", errors),
        responsibleAgentId: body.responsibleAgentId === undefined || body.responsibleAgentId === null ? undefined : requiredId(body, "responsibleAgentId", errors),
        vacancies: body.vacancies === undefined ? null : parseVacancies(body.vacancies, errors),
        companyJobId: body.companyJobId === undefined ? null : normalizeCompanyJobId(body.companyJobId, errors),
        fromCountryCode: body.fromCountryCode === undefined ? DEFAULT_FROM_COUNTRY : parseFromCountry(body.fromCountryCode, errors),
        candidateIds: body.candidateIds === undefined ? [] : parseCandidateIds(body.candidateIds, errors),
    };
    if (body.countryCode !== undefined) errors.push({ field: "countryCode", message: "cannot be set: the To Country is the responsible agent's country" });
    return errors.length ? { errors } : { values };
}

// PUT /api/admin/jobs/:jobId { vacancies?, jobTypeId?, clientId?, companyJobId?, fromCountryCode? }.
// companyJobId (null clears it) may be changed on a job in any status; the other
// fields only while PROCESSING. The responsible Agent, the To Country (countryCode),
// the job code and the job id are fixed.
export function parseUpdateJobBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const values = {};
    if (body.vacancies !== undefined) {
        const vacancies = parseVacancies(body.vacancies, errors);
        if (vacancies !== undefined) values.vacancies = vacancies;
    }
    if (body.jobTypeId !== undefined) values.jobTypeId = requiredId(body, "jobTypeId", errors);
    if (body.clientId !== undefined) values.clientId = requiredId(body, "clientId", errors);
    if (body.companyJobId !== undefined) {
        const companyJobId = normalizeCompanyJobId(body.companyJobId, errors);
        if (companyJobId !== undefined) values.companyJobId = companyJobId;
    }
    if (body.fromCountryCode !== undefined) {
        const code = parseFromCountry(body.fromCountryCode, errors);
        if (code !== undefined) values.fromCountryCode = code;
    }
    for (const field of ["responsibleAgentId", "countryCode", "status", "jobCode"]) {
        if (body[field] !== undefined) errors.push({ field, message: "cannot be changed here" });
    }
    if (!errors.length && Object.keys(values).length === 0) errors.push({ field: "body", message: "must contain vacancies, jobTypeId, clientId, companyJobId or fromCountryCode" });
    return errors.length ? { errors } : { values };
}

// POST /api/admin/jobs/:jobId/candidates { passportId }
export function parseAddCandidateBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    if (typeof body.passportId !== "string" || !PASSPORT_ID_PATTERN.test(body.passportId.trim())) {
        return { errors: [{ field: "passportId", message: "must be a passport ID" }] };
    }
    return { values: { passportId: body.passportId.trim() } };
}

// POST /api/admin/jobs/:jobId/cancel { reason }
export function parseCancelBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return { errors: [{ field: "reason", message: "is required to cancel a job" }] };
    if (reason.length > MAX_CANCEL_REASON_LENGTH) return { errors: [{ field: "reason", message: `must be at most ${MAX_CANCEL_REASON_LENGTH} characters` }] };
    return { values: { reason } };
}

function parseName(body, field, errors) {
    const value = typeof body[field] === "string" ? body[field].trim().replace(/\s+/g, " ") : "";
    if (!value) errors.push({ field, message: "is required" });
    else if (value.length > MAX_NAME_LENGTH) errors.push({ field, message: `must be at most ${MAX_NAME_LENGTH} characters` });
    return value;
}

// POST /api/admin/job-types { name }
export function parseReferenceBody(body, { withCountry = false } = {}) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const values = { name: parseName(body, "name", errors) };
    if (withCountry) {
        if (typeof body.countryCode !== "string" || !COUNTRY_PATTERN.test(body.countryCode.trim())) {
            errors.push({ field: "countryCode", message: "must be a 2-letter country code (e.g. RO)" });
        } else {
            values.countryCode = body.countryCode.trim().toUpperCase();
        }
    }
    return errors.length ? { errors } : { values };
}

// ---------------------------------------------------------------- Job Code

// JOB-YYYY-NNNNNN from a yearly counter row, incremented by ONE atomic
// statement inside the caller's transaction: concurrent creations queue on the
// counter row's lock, so a number is never handed out twice and is never
// skipped by a rolled-back creation (the increment rolls back with it).
// The year is the Asia/Colombo calendar year (the project's operating zone).
export const jobCodeYear = (now = new Date()) => Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo", year: "numeric" }).format(now));
export const formatJobCode = (year, number) => `JOB-${year}-${String(number).padStart(6, "0")}`;

async function nextJobCode(tx, now) {
    const year = jobCodeYear(now);
    const rows = await tx.$queryRaw`
        INSERT INTO "job_code_counter" ("year", "next_number") VALUES (${year}, 2)
        ON CONFLICT ("year") DO UPDATE SET "next_number" = "job_code_counter"."next_number" + 1
        RETURNING "next_number" - 1 AS "number"`;
    return formatJobCode(year, Number(rows[0].number));
}

// ---------------------------------------------------------------- reference data

const referenceView = (row) => ({ id: row.id, name: row.name, ...(row.countryCode ? { countryCode: row.countryCode } : {}), ...(row.code ? { code: row.code } : {}) });

// GET /api/admin/job-options: the active job types, clients and agents a job can use. Only an
// ACTIVE client with at least one ACTIVE linked agent is offered; agentIds are its ACTIVE
// agents (agent_client), any of which can be the job's responsible agent. The To Country is
// the chosen agent's country (agents carry countryCode): a client of agents in several
// countries has no single country, so nothing is pre-chosen for it.
export async function listJobOptions({ db }) {
    const [jobTypes, clients, agents] = await Promise.all([
        db.jobType.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
        db.client.findMany({
            where: { isActive: true, agentLinks: { some: { agent: { isActive: true } } } },
            select: { id: true, name: true, agentLinks: { where: { agent: { isActive: true } }, select: { agentId: true }, orderBy: { agentId: "asc" } } },
            orderBy: [{ name: "asc" }, { id: "asc" }],
        }),
        db.agent.findMany({ where: { isActive: true }, select: { id: true, name: true, countryCode: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
    ]);
    return { jobTypes: jobTypes.map(referenceView), clients: clients.map((row) => ({ id: row.id, name: row.name, agentIds: row.agentLinks.map((link) => link.agentId) })), agents: agents.map(referenceView) };
}

const auditRow = ({ actor, action, passportId = null, previousStatus, newStatus, reason = null, previousValue = null, newValue = null }) => ({
    auditId: crypto.randomUUID(), adminId: actor.adminId, action, passportId, previousStatus, newStatus, reason, previousValue, newValue,
});

const codeFromName = (name) => name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

async function createReference({ db, actor, model, data, action, label, duplicateMessage }) {
    try {
        return await db.$transaction(async (tx) => {
            const row = await tx[model].create({ data });
            await tx.auditLog.create({ data: auditRow({ actor, action, previousStatus: "NONE", newStatus: "CREATED", reason: `${label} created`, newValue: JSON.stringify({ id: row.id, name: row.name }) }) });
            return referenceView(row);
        });
    } catch (error) {
        if (isUniqueViolation(error)) throw new CandidateError(409, "DUPLICATE", duplicateMessage);
        throw error;
    }
}

const DUPLICATE_JOB_TYPE = "A job type with this name already exists.";

export function createJobType({ db, actor, values }) {
    const code = codeFromName(values.name);
    if (!code) throw new CandidateError(400, "INVALID_NAME", "The name must contain letters or digits.");
    return createReference({ db, actor, model: "jobType", data: { code, name: values.name }, action: JOB_AUDIT_ACTION.CREATE_JOB_TYPE, label: "Job type", duplicateMessage: DUPLICATE_JOB_TYPE });
}

// Settings > Job Types (ADMIN): every job type, active or not, with how many jobs
// use it. "No Preferred Type" is not in this table (jobTypeCatalog.js): the page
// shows it as a system option.
export async function listJobTypes({ db }) {
    const rows = await db.jobType.findMany({
        select: { id: true, code: true, name: true, isActive: true, createdAt: true, updatedAt: true, _count: { select: { jobs: true } } },
        orderBy: [{ isActive: "desc" }, { name: "asc" }, { id: "asc" }],
    });
    return {
        items: rows.map((row) => ({
            id: row.id, code: row.code, name: row.name, isActive: row.isActive, jobCount: row._count.jobs,
            createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
        })),
    };
}

// PATCH /api/admin/job-types/:id { name?, isActive? } (ADMIN). Renaming keeps the
// type's id and code, so every Job on it shows the new name; candidates keep the
// text they saved. Deactivating only stops NEW selections: existing Jobs (any
// status) and candidates keep it. Nothing is ever deleted (Jobs reference it).
export function parseJobTypeUpdate(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const values = {};
    for (const key of Object.keys(body)) if (key !== "name" && key !== "isActive") errors.push({ field: key, message: "is not accepted" });
    if (body.name !== undefined) {
        const parsed = parseReferenceBody({ name: body.name });
        if (parsed.errors) errors.push(...parsed.errors);
        else values.name = parsed.values.name;
    }
    if (body.isActive !== undefined) {
        if (typeof body.isActive !== "boolean") errors.push({ field: "isActive", message: "must be true or false" });
        else values.isActive = body.isActive;
    }
    if (!errors.length && !Object.keys(values).length) errors.push({ field: "body", message: "must contain name or isActive" });
    return errors.length ? { errors } : { values };
}

export async function updateJobType({ db, actor, id, values }) {
    if (!isValidJobIdParam(id)) throw new CandidateError(404, "JOB_TYPE_NOT_FOUND", "Job type not found");
    try {
        return await db.$transaction(async (tx) => {
            const before = await tx.jobType.findUnique({ where: { id }, select: { id: true, name: true, isActive: true } });
            if (!before) throw new CandidateError(404, "JOB_TYPE_NOT_FOUND", "Job type not found");
            const changes = {};
            if (values.name !== undefined && values.name !== before.name) changes.name = values.name;
            if (values.isActive !== undefined && values.isActive !== before.isActive) changes.isActive = values.isActive;
            if (Object.keys(changes).length) {
                await tx.jobType.update({ where: { id }, data: changes });
                if (changes.name !== undefined) {
                    await tx.auditLog.create({ data: auditRow({ actor, action: JOB_AUDIT_ACTION.UPDATE_JOB_TYPE, previousStatus: "ACTIVE_OR_INACTIVE", newStatus: "RENAMED", reason: "Job type renamed", previousValue: JSON.stringify({ id, name: before.name }), newValue: JSON.stringify({ id, name: changes.name }) }) });
                }
                if (changes.isActive !== undefined) {
                    await tx.auditLog.create({
                        data: auditRow({
                            actor, action: changes.isActive ? JOB_AUDIT_ACTION.ACTIVATE_JOB_TYPE : JOB_AUDIT_ACTION.DEACTIVATE_JOB_TYPE,
                            previousStatus: before.isActive ? "ACTIVE" : "INACTIVE", newStatus: changes.isActive ? "ACTIVE" : "INACTIVE",
                            reason: changes.isActive ? "Job type activated" : "Job type deactivated", newValue: JSON.stringify({ id, name: changes.name ?? before.name }),
                        }),
                    });
                }
            }
            const row = await tx.jobType.findUnique({ where: { id }, select: { id: true, code: true, name: true, isActive: true, createdAt: true, updatedAt: true, _count: { select: { jobs: true } } } });
            return { id: row.id, code: row.code, name: row.name, isActive: row.isActive, jobCount: row._count.jobs, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
        });
    } catch (error) {
        if (isUniqueViolation(error)) throw new CandidateError(409, "DUPLICATE", DUPLICATE_JOB_TYPE);
        throw error;
    }
}

// ---------------------------------------------------------------- views

// The jobs an Analyst may see hold a candidate allocated to them.
const memberWhere = (user) => ({ releasedAt: null, ...(isCandidateScoped(user) ? { candidate: candidateScope(user) } : {}) });

// Filled: the job has at least as many assigned candidates as vacancies (all of its candidates,
// whoever may see them). Derived, never stored, and it never limits assigning: 23 / 20 is still
// Filled and the vacancies stay 20. A job without vacancies is never Filled. The job's status
// (PROCESSING / COMPLETED / CANCELLED) is separate and only changes by Complete / Cancel.
export const isJobFilled = (vacancies, assigned) => typeof vacancies === "number" && assigned >= vacancies;

// Assigned (not removed) candidates per job, every candidate counted: what Filled is measured on
// when the user's own count is scoped (an Analyst sees only their candidates).
async function assignedCounts(db, jobIds) {
    if (!jobIds.length) return new Map();
    const groups = await db.jobCandidate.groupBy({ by: ["jobId"], where: { jobId: { in: jobIds }, releasedAt: null }, _count: { _all: true } });
    return new Map(groups.map((group) => [group.jobId, group._count._all]));
}

const listRow = (row, assigned) => ({ ...jobSummaryView(row), candidateCount: row._count.candidates, filled: isJobFilled(row.vacancies, assigned) });

function searchWhere(search) {
    const words = search.split(/\s+/).filter(Boolean).slice(0, 5);
    return {
        AND: words.map((word) => ({
            OR: [
                { jobCode: { contains: word, mode: "insensitive" } },
                { companyJobId: { contains: word, mode: "insensitive" } },
                { client: { name: { contains: word, mode: "insensitive" } } },
                { responsibleAgent: { name: { contains: word, mode: "insensitive" } } },
                { jobType: { name: { contains: word, mode: "insensitive" } } },
                { countryCode: { equals: word.toUpperCase() } },
            ],
        })),
    };
}

// GET /api/admin/jobs
export async function listJobs({ db, params, user }) {
    const parts = [{ status: JOB_VIEWS[params.view] }];
    if (isCandidateScoped(user)) parts.push({ candidates: { some: memberWhere(user) } });
    if (params.search) parts.push(searchWhere(params.search));
    const where = { AND: parts };
    const [total, rows, counts] = await Promise.all([
        db.job.count({ where }),
        db.job.findMany({
            where,
            select: { ...JOB_SELECT, _count: { select: { candidates: { where: memberWhere(user) } } } },
            orderBy: [{ createdAt: "desc" }, { jobCode: "desc" }],
            skip: (params.page - 1) * params.pageSize,
            take: params.pageSize,
        }),
        // The three tab badges (only what the user may see).
        db.job.groupBy({ by: ["status"], where: isCandidateScoped(user) ? { candidates: { some: memberWhere(user) } } : {}, _count: { _all: true } }),
    ]);
    const countOf = (status) => counts.find((group) => group.status === status)?._count._all ?? 0;
    const scoped = isCandidateScoped(user) ? await assignedCounts(db, rows.map((row) => row.id)) : null;
    return {
        items: rows.map((row) => listRow(row, scoped ? scoped.get(row.id) ?? 0 : row._count.candidates)),
        pagination: listPagination(params, total),
        counts: { processing: countOf(JOB_STATUS.PROCESSING), completed: countOf(JOB_STATUS.COMPLETED), cancelled: countOf(JOB_STATUS.CANCELLED) },
        filters: { view: params.view, search: params.search ?? null },
    };
}

// GET /api/admin/jobs/:jobId. An Analyst gets only their own candidates of the
// job (and 404 when it holds none of theirs).
export async function getJob({ db, jobId, user }) {
    const row = await db.job.findFirst({
        where: isCandidateScoped(user) ? { AND: [{ id: jobId }, { candidates: { some: memberWhere(user) } }] } : { id: jobId },
        select: {
            ...JOB_SELECT,
            createdBy: { select: { name: true } },
            candidates: {
                where: memberWhere(user),
                // The workflow signals too: each candidate's Status is the Candidates list's own (candidateService.js).
                select: { assignedAt: true, candidate: { select: WORKFLOW_STATUS_SELECT } },
                orderBy: [{ assignedAt: "asc" }, { passportId: "asc" }],
            },
        },
    });
    if (!row) throw new CandidateError(404, "JOB_NOT_FOUND", "Job not found");
    const statuses = await candidateWorkflowStatuses(db, row.candidates.map((member) => member.candidate));
    const assigned = isCandidateScoped(user) ? (await assignedCounts(db, [row.id])).get(row.id) ?? 0 : row.candidates.length;
    return {
        ...jobSummaryView(row),
        createdBy: row.createdBy?.name ?? null,
        candidateCount: row.candidates.length,
        filled: isJobFilled(row.vacancies, assigned),
        candidates: row.candidates.map((member) => ({
            passportId: member.candidate.passportId,
            uniqueId: member.candidate.uniqueId,
            name: clientName(member.candidate),
            nic: member.candidate.nic ?? null,
            assignedAt: iso(member.assignedAt),
            workflowStatus: statuses.get(member.candidate.passportId),
        })),
    };
}

// ---------------------------------------------------------------- writing

// Locks the job row (FOR SHARE for membership changes: they run side by side,
// but never beside a completion or cancellation, which update the row).
async function lockJob(tx, jobId, mode) {
    const rows = mode === "update"
        ? await tx.$queryRaw`SELECT "id", "job_code" AS "jobCode", "status" FROM "job" WHERE "id" = ${jobId}::uuid FOR UPDATE`
        : await tx.$queryRaw`SELECT "id", "job_code" AS "jobCode", "status" FROM "job" WHERE "id" = ${jobId}::uuid FOR SHARE`;
    if (!rows.length) throw new CandidateError(404, "JOB_NOT_FOUND", "Job not found");
    return rows[0];
}

function requireProcessing(job) {
    if (job.status !== JOB_STATUS.PROCESSING) {
        throw new CandidateError(409, "JOB_NOT_PROCESSING", `Job ${job.jobCode} is ${job.status.toLowerCase()}; only a PROCESSING job can be changed.`);
    }
}

async function requireActive(tx, model, id, field, label) {
    const row = await tx[model].findUnique({ where: { id }, select: { id: true, isActive: true, ...(model === "agent" ? { countryCode: true } : {}) } });
    if (!row || !row.isActive) throw new CandidateError(400, "REFERENCE_NOT_FOUND", `The selected ${label} does not exist or is no longer active.`);
    return row;
}

// The Client a job is (or will be) for: it must exist and be ACTIVE, and the job's
// responsible Agent must be one of the Client's Agents (agent_client) and ACTIVE.
// `agentId` is what the caller asked for. Omitted, it is the Client's Agent only when
// the Client has exactly ONE; a Client with several Agents needs an explicit choice
// (409 AGENT_REQUIRED): no Agent is ever picked by order, so the job's To Country (the
// chosen Agent's country) is never a guess. Never trusts the browser: a Client/Agent
// pair that is not linked is refused whatever the form showed.
async function requireClientWithAgent(tx, clientId, agentId) {
    // Share-locks the client, then the chosen agent (client-first, like every writer of
    // these rows), for the rest of the transaction, so a deactivation or a link change
    // (which lock FOR UPDATE) cannot slip in between this check and the insert.
    await tx.$queryRaw`SELECT "id" FROM "client" WHERE "id" = ${clientId}::uuid FOR SHARE`;
    const client = await tx.client.findUnique({ where: { id: clientId }, select: { id: true, isActive: true, agentLinks: { select: { agentId: true }, orderBy: { agentId: "asc" } } } });
    if (!client) throw new CandidateError(400, "REFERENCE_NOT_FOUND", "The selected client does not exist.");
    if (!client.isActive) throw new CandidateError(409, "CLIENT_INACTIVE", "This client is inactive. Activate it before creating or moving a job for it.");
    const linked = client.agentLinks.map((link) => link.agentId);
    if (!linked.length) throw new CandidateError(409, "CLIENT_HAS_NO_AGENT", "This client has no agent. Add an agent to the client first.");
    if (agentId && !linked.includes(agentId)) throw new CandidateError(409, "CLIENT_AGENT_MISMATCH", "The selected agent is not one of this client's agents.");
    if (!agentId && linked.length > 1) throw new CandidateError(409, "AGENT_REQUIRED", "This client works with several agents. Choose the responsible agent for the job.");
    const chosen = agentId ?? linked[0];
    await tx.$queryRaw`SELECT "id" FROM "agent" WHERE "id" = ${chosen}::uuid FOR SHARE`;
    const agent = await tx.agent.findUnique({ where: { id: chosen }, select: { id: true, isActive: true, countryCode: true } });
    if (!agent.isActive) throw new CandidateError(409, "AGENT_INACTIVE", "The responsible agent is inactive. Choose an active agent of this client, or activate it first.");
    return { client, agent };
}

// POST /api/admin/jobs. The job's To Country (country_code) is its responsible Agent's
// country at creation time (a snapshot: later Agent or link changes never rewrite it).
// candidateIds are assigned in the SAME
// transaction as the job is created: every one passes every assignment rule or
// nothing is created at all (never a job with half its candidates). The vacancies
// never limit how many are assigned.
export async function createJob({ db, actor, values, now = new Date() }) {
    const passportIds = [];
    for (const requested of values.candidateIds ?? []) {
        const stored = await resolveCandidatePassportId({ db, passportId: requested });
        if (!stored) throw new CandidateError(404, "CANDIDATE_NOT_FOUND", `Candidate ${requested} was not found. Nothing was created.`);
        passportIds.push(stored);
    }
    // One per stored candidate (two spellings of one passport ID count once), locked in a fixed
    // order so two creations that share candidates cannot deadlock.
    const unique = [...new Set(passportIds)].sort();
    try {
        return await createJobInTransaction({ db, actor, values, passportIds: unique, now });
    } catch (error) {
        if (isUniqueViolation(error)) throw new CandidateError(409, "COMPANY_JOB_ID_EXISTS", COMPANY_JOB_ID_TAKEN);
        throw error;
    }
}

async function createJobInTransaction({ db, actor, values, passportIds, now }) {
    return db.$transaction(async (tx) => {
        await requireActive(tx, "jobType", values.jobTypeId, "jobTypeId", "job type");
        const { agent } = await requireClientWithAgent(tx, values.clientId, values.responsibleAgentId);
        const jobCode = await nextJobCode(tx, now);
        const job = await tx.job.create({
            data: {
                jobCode,
                companyJobId: values.companyJobId,
                jobTypeId: values.jobTypeId,
                clientId: values.clientId,
                responsibleAgentId: agent.id,
                countryCode: agent.countryCode,
                fromCountryCode: values.fromCountryCode ?? DEFAULT_FROM_COUNTRY,
                vacancies: values.vacancies,
                status: JOB_STATUS.PROCESSING,
                createdById: actor.adminId,
            },
            select: { id: true, jobCode: true, status: true },
        });
        const fields = Object.fromEntries(Object.entries(values).filter(([key]) => key !== "candidateIds"));
        await tx.auditLog.create({
            data: auditRow({
                actor, action: JOB_AUDIT_ACTION.CREATE, previousStatus: "NONE", newStatus: JOB_STATUS.PROCESSING, reason: `Job ${job.jobCode} created`,
                newValue: JSON.stringify({ jobId: job.id, jobCode: job.jobCode, ...fields, responsibleAgentId: agent.id, countryCode: agent.countryCode, candidates: passportIds.length }),
            }),
        });
        for (const passportId of passportIds) {
            try {
                await assignCandidate(tx, { actor, job, passportId });
            } catch (error) {
                // Named, and the whole creation rolls back with it.
                if (error instanceof CandidateError) throw new CandidateError(error.status, error.code, `${passportId}: ${error.message} Nothing was created.`);
                throw error;
            }
        }
        return getJob({ db: tx, jobId: job.id, user: actor });
    });
}

const COMPANY_JOB_ID_TAKEN = "Another job of this client already has this Company Job ID.";

// PUT /api/admin/jobs/:jobId. The Company Job ID is a plain attribute: changing
// it touches nothing else (job.id, job_candidate and the Candidate Form links
// all use the immutable id), so it may change on a finished job too; every other
// field needs a PROCESSING job.
export async function updateJob({ db, actor, jobId, values }) {
    try {
        return await updateJobInTransaction({ db, actor, jobId, values });
    } catch (error) {
        if (isUniqueViolation(error)) throw new CandidateError(409, "COMPANY_JOB_ID_EXISTS", COMPANY_JOB_ID_TAKEN);
        throw error;
    }
}

async function updateJobInTransaction({ db, actor, jobId, values }) {
    return db.$transaction(async (tx) => {
        const job = await lockJob(tx, jobId, "update");
        if (Object.keys(values).some((key) => key !== "companyJobId")) requireProcessing(job);
        const before = await tx.job.findUnique({ where: { id: jobId }, select: { companyJobId: true, vacancies: true, jobTypeId: true, clientId: true, responsibleAgentId: true } });
        // A NEW job type must be active; keeping the job's own type (even one deactivated
        // since) is always allowed, so an edit never fails on a type it does not change.
        if (values.jobTypeId && values.jobTypeId !== before.jobTypeId) await requireActive(tx, "jobType", values.jobTypeId, "jobTypeId", "job type");
        if (values.clientId) await requireClientWithAgent(tx, values.clientId, before.responsibleAgentId);
        await tx.job.update({ where: { id: jobId }, data: values });
        await tx.auditLog.create({
            data: auditRow({
                actor, action: JOB_AUDIT_ACTION.UPDATE, previousStatus: job.status, newStatus: job.status, reason: `Job ${job.jobCode} updated`,
                previousValue: JSON.stringify({ jobId, ...Object.fromEntries(Object.keys(values).map((key) => [key, before[key]])) }),
                newValue: JSON.stringify({ jobId, ...values }),
            }),
        });
        return getJob({ db: tx, jobId, user: actor });
    });
}

// Assigns one candidate to a PROCESSING job inside the caller's transaction (Add to job, and
// New job with selected candidates). Every rule is checked here under row locks (the caller
// holds the job; the candidate FOR UPDATE), so two staff members assigning the same candidate
// to two jobs queue on the candidate's lock and the second sees the first's assignment (409).
// The partial unique index is the backstop: a violation is the same 409. The job's vacancies
// are never checked: a job may hold more candidates than vacancies (23 / 20).
async function assignCandidate(tx, { actor, job, passportId }) {
    const jobId = job.id;
    const locked = await tx.$queryRaw`SELECT "passport_id" FROM "candidate" WHERE "passport_id" = ${passportId} FOR UPDATE`;
    if (!locked.length) throw new CandidateError(404, "CANDIDATE_NOT_FOUND", "Candidate not found");

    const active = await tx.jobCandidate.findFirst({ where: { passportId, isActive: true }, select: { jobId: true, job: { select: { jobCode: true } } } });
    if (active?.jobId === jobId) throw new CandidateError(409, "CANDIDATE_ALREADY_IN_JOB", `This candidate is already assigned to ${job.jobCode}.`);
    if (active) throw new CandidateError(409, "CANDIDATE_ON_ACTIVE_JOB", `This candidate is already on the PROCESSING job ${active.job.jobCode}. Complete or cancel that job, or remove the candidate from it, first.`);

    // Only a candidate who PASSED the test can be assigned (also a removed candidate put back, and a
    // candidate being moved to another job after leaving the first). The saved Test details result is
    // the only source (not stage completion, not the Job details stage, not the legacy job_id); the row
    // is share-locked so the result cannot change between this check and the insert. Existing
    // assignments are never touched when a result later changes. The candidate's job type preference
    // is never compared with the job's type: assignment stays open by Job Type.
    const [test] = await tx.$queryRaw`SELECT "test_result" AS "result" FROM "candidate_stages" WHERE "passport_id" = ${passportId} AND "stage" = 'TEST_DETAILS' FOR SHARE`;
    if (test?.result !== TEST_RESULT_PASS) {
        throw new CandidateError(409, "CANDIDATE_TEST_NOT_PASSED", "Candidate must pass the test before being assigned to a job.");
    }

    const existing = await tx.jobCandidate.findUnique({ where: { jobId_passportId: { jobId, passportId } }, select: { releasedAt: true } });
    const now = new Date();
    try {
        if (existing) {
            // Removed earlier from this same job: the same membership row is reused.
            await tx.jobCandidate.update({ where: { jobId_passportId: { jobId, passportId } }, data: { isActive: true, releasedAt: null, assignedAt: now, assignedBy: actor.adminId } });
        } else {
            await tx.jobCandidate.create({ data: { jobId, passportId, assignedAt: now, assignedBy: actor.adminId, isActive: true } });
        }
    } catch (error) {
        if (isUniqueViolation(error)) throw new CandidateError(409, "CANDIDATE_ON_ACTIVE_JOB", "This candidate was just assigned to a PROCESSING job. Nothing was changed; refresh and check.");
        throw error;
    }
    await tx.auditLog.create({
        data: auditRow({ actor, action: JOB_AUDIT_ACTION.ADD_CANDIDATE, passportId, previousStatus: "NOT_ASSIGNED", newStatus: "ASSIGNED", reason: `Assigned to ${job.jobCode}`, newValue: JSON.stringify({ jobId, jobCode: job.jobCode }) }),
    });
}

// POST /api/admin/jobs/:jobId/candidates (job FOR SHARE, then assignCandidate).
export async function addCandidateToJob({ db, actor, jobId, passportId }) {
    const stored = await resolveCandidatePassportId({ db, passportId });
    if (!stored) throw new CandidateError(404, "CANDIDATE_NOT_FOUND", "Candidate not found");
    try {
        return await db.$transaction(async (tx) => {
            const job = await lockJob(tx, jobId, "share");
            requireProcessing(job);
            await assignCandidate(tx, { actor, job, passportId: stored });
            return getJob({ db: tx, jobId, user: actor });
        });
    } catch (error) {
        if (isUniqueViolation(error)) throw new CandidateError(409, "CANDIDATE_ON_ACTIVE_JOB", "This candidate was just assigned to a PROCESSING job. Nothing was changed; refresh and check.");
        throw error;
    }
}

// DELETE /api/admin/jobs/:jobId/candidates/:passportId: takes the candidate
// off a PROCESSING job (the membership row stays, marked released).
export async function removeCandidateFromJob({ db, actor, jobId, passportId }) {
    return db.$transaction(async (tx) => {
        const job = await lockJob(tx, jobId, "share");
        requireProcessing(job);
        const member = await tx.jobCandidate.findFirst({ where: { jobId, passportId: { equals: passportId, mode: "insensitive" }, releasedAt: null }, select: { passportId: true } });
        if (!member) throw new CandidateError(404, "CANDIDATE_NOT_IN_JOB", "This candidate is not assigned to the job.");
        await tx.jobCandidate.update({ where: { jobId_passportId: { jobId, passportId: member.passportId } }, data: { isActive: false, releasedAt: new Date() } });
        await tx.auditLog.create({
            data: auditRow({ actor, action: JOB_AUDIT_ACTION.REMOVE_CANDIDATE, passportId: member.passportId, previousStatus: "ASSIGNED", newStatus: "NOT_ASSIGNED", reason: `Removed from ${job.jobCode}`, previousValue: JSON.stringify({ jobId, jobCode: job.jobCode }) }),
        });
        return getJob({ db: tx, jobId, user: actor });
    });
}

// Leaves PROCESSING. The database trigger clears every membership's
// is_active in the same transaction; the rows are kept.
async function closeJob({ db, actor, jobId, status, action, data, reason }) {
    return db.$transaction(async (tx) => {
        const job = await lockJob(tx, jobId, "update");
        requireProcessing(job);
        await tx.job.update({ where: { id: jobId }, data: { status, ...data } });
        const members = await tx.jobCandidate.count({ where: { jobId, releasedAt: null } });
        await tx.auditLog.create({
            data: auditRow({ actor, action, previousStatus: job.status, newStatus: status, reason: reason ?? `Job ${job.jobCode} ${status.toLowerCase()}`, newValue: JSON.stringify({ jobId, jobCode: job.jobCode, candidates: members }) }),
        });
        return getJob({ db: tx, jobId, user: actor });
    });
}

export const completeJob = ({ db, actor, jobId, now = new Date() }) =>
    closeJob({ db, actor, jobId, status: JOB_STATUS.COMPLETED, action: JOB_AUDIT_ACTION.COMPLETE, data: { completedAt: now } });

export const cancelJob = ({ db, actor, jobId, reason, now = new Date() }) =>
    closeJob({ db, actor, jobId, status: JOB_STATUS.CANCELLED, action: JOB_AUDIT_ACTION.CANCEL, data: { cancelledAt: now, cancelReason: reason }, reason });
