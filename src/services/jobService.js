import crypto from "node:crypto";

import { CandidateError, listPagination, resolveCandidatePassportId } from "./candidateService.js";
import { candidateScope, isCandidateScoped } from "./candidateAccess.js";
import { JOB_SELECT, JOB_STATUS, jobSummaryView } from "./jobAssignmentReader.js";
import { clientName } from "../utils/clientName.js";

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

// POST /api/admin/jobs { jobTypeId, clientId, responsibleAgentId?, vacancies? }
// responsibleAgentId is optional: omitted, the Client's own Agent is used. Given, it
// must be that Agent (the service rejects any other combination).
export function parseCreateJobBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const values = {
        jobTypeId: requiredId(body, "jobTypeId", errors),
        clientId: requiredId(body, "clientId", errors),
        responsibleAgentId: body.responsibleAgentId === undefined || body.responsibleAgentId === null ? undefined : requiredId(body, "responsibleAgentId", errors),
        vacancies: body.vacancies === undefined ? null : parseVacancies(body.vacancies, errors),
        companyJobId: body.companyJobId === undefined ? null : normalizeCompanyJobId(body.companyJobId, errors),
    };
    return errors.length ? { errors } : { values };
}

// PUT /api/admin/jobs/:jobId { vacancies?, jobTypeId?, clientId?, companyJobId? }.
// companyJobId (null clears it) may be changed on a job in any status; the other
// fields only while PROCESSING. The responsible Agent, the country, the job code
// and the job id are fixed.
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
    for (const field of ["responsibleAgentId", "countryCode", "status", "jobCode"]) {
        if (body[field] !== undefined) errors.push({ field, message: "cannot be changed here" });
    }
    if (!errors.length && Object.keys(values).length === 0) errors.push({ field: "body", message: "must contain vacancies, jobTypeId, clientId or companyJobId" });
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

// GET /api/admin/job-options: the active job types, clients (each with its Agent) and
// agents a job can use. Only an ACTIVE client of an ACTIVE agent is offered.
export async function listJobOptions({ db }) {
    const [jobTypes, clients, agents] = await Promise.all([
        db.jobType.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
        db.client.findMany({ where: { isActive: true, agent: { is: { isActive: true } } }, select: { id: true, name: true, agentId: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
        db.agent.findMany({ where: { isActive: true }, select: { id: true, name: true, countryCode: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
    ]);
    return { jobTypes: jobTypes.map(referenceView), clients: clients.map((row) => ({ id: row.id, name: row.name, agentId: row.agentId })), agents: agents.map(referenceView) };
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

export function createJobType({ db, actor, values }) {
    const code = codeFromName(values.name);
    if (!code) throw new CandidateError(400, "INVALID_NAME", "The name must contain letters or digits.");
    return createReference({ db, actor, model: "jobType", data: { code, name: values.name }, action: JOB_AUDIT_ACTION.CREATE_JOB_TYPE, label: "Job type", duplicateMessage: "A job type with this name already exists." });
}

// ---------------------------------------------------------------- views

// The jobs an Analyst may see hold a candidate allocated to them.
const memberWhere = (user) => ({ releasedAt: null, ...(isCandidateScoped(user) ? { candidate: candidateScope(user) } : {}) });

const listRow = (row) => ({ ...jobSummaryView(row), candidateCount: row._count.candidates });

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
    return {
        items: rows.map(listRow),
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
                select: { assignedAt: true, candidate: { select: { passportId: true, uniqueId: true, firstName: true, otherName: true, nic: true } } },
                orderBy: [{ assignedAt: "asc" }, { passportId: "asc" }],
            },
        },
    });
    if (!row) throw new CandidateError(404, "JOB_NOT_FOUND", "Job not found");
    return {
        ...jobSummaryView(row),
        createdBy: row.createdBy?.name ?? null,
        candidateCount: row.candidates.length,
        candidates: row.candidates.map((member) => ({
            passportId: member.candidate.passportId,
            uniqueId: member.candidate.uniqueId,
            name: clientName(member.candidate),
            nic: member.candidate.nic ?? null,
            assignedAt: iso(member.assignedAt),
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

// The Client a job is (or will be) for: it must exist and be ACTIVE, and its
// responsible Agent must be ACTIVE and be the job's Agent. `agentId` is what the
// caller asked for (undefined: use the Client's Agent). Never trusts the browser:
// a Client/Agent pair that does not match is refused whatever the form showed.
async function requireClientWithAgent(tx, clientId, agentId) {
    // Share-locks the client and its agent for the rest of the transaction, so a
    // deactivation (which locks FOR UPDATE and then counts PROCESSING jobs)
    // cannot slip in between this check and the insert.
    await tx.$queryRaw`SELECT "id" FROM "client" WHERE "id" = ${clientId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT a."id" FROM "agent" a JOIN "client" c ON c."agent_id" = a."id" WHERE c."id" = ${clientId}::uuid FOR SHARE OF a`;
    const client = await tx.client.findUnique({ where: { id: clientId }, select: { id: true, isActive: true, agentId: true, agent: { select: { id: true, isActive: true, countryCode: true } } } });
    if (!client) throw new CandidateError(400, "REFERENCE_NOT_FOUND", "The selected client does not exist.");
    if (!client.isActive) throw new CandidateError(409, "CLIENT_INACTIVE", "This client is inactive. Activate it before creating or moving a job for it.");
    if (!client.agent) throw new CandidateError(409, "CLIENT_HAS_NO_AGENT", "This client has no responsible agent. Assign an agent to the client first.");
    if (agentId && agentId !== client.agentId) throw new CandidateError(409, "CLIENT_AGENT_MISMATCH", "The selected agent is not the responsible agent of this client.");
    if (!client.agent.isActive) throw new CandidateError(409, "AGENT_INACTIVE", "The client's responsible agent is inactive. Assign an active agent to the client first.");
    return { client, agent: client.agent };
}

// POST /api/admin/jobs. The job's country is the responsible Agent's country
// at creation time.
export async function createJob({ db, actor, values, now = new Date() }) {
    try {
        return await createJobInTransaction({ db, actor, values, now });
    } catch (error) {
        if (isUniqueViolation(error)) throw new CandidateError(409, "COMPANY_JOB_ID_EXISTS", COMPANY_JOB_ID_TAKEN);
        throw error;
    }
}

async function createJobInTransaction({ db, actor, values, now }) {
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
                vacancies: values.vacancies,
                status: JOB_STATUS.PROCESSING,
                createdById: actor.adminId,
            },
            select: { id: true, jobCode: true },
        });
        await tx.auditLog.create({
            data: auditRow({
                actor, action: JOB_AUDIT_ACTION.CREATE, previousStatus: "NONE", newStatus: JOB_STATUS.PROCESSING, reason: `Job ${job.jobCode} created`,
                newValue: JSON.stringify({ jobId: job.id, jobCode: job.jobCode, ...values, responsibleAgentId: agent.id, countryCode: agent.countryCode }),
            }),
        });
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
        if (values.jobTypeId) await requireActive(tx, "jobType", values.jobTypeId, "jobTypeId", "job type");
        if (values.clientId) {
            const current = await tx.job.findUnique({ where: { id: jobId }, select: { responsibleAgentId: true } });
            await requireClientWithAgent(tx, values.clientId, current.responsibleAgentId);
        }
        const before = await tx.job.findUnique({ where: { id: jobId }, select: { companyJobId: true, vacancies: true, jobTypeId: true, clientId: true, responsibleAgentId: true } });
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

// POST /api/admin/jobs/:jobId/candidates. All five rules are checked inside
// one transaction under row locks (job FOR SHARE, candidate FOR UPDATE), so two
// staff members assigning the same candidate to two jobs queue on the
// candidate's lock and the second sees the first's assignment (409). The
// partial unique index is the backstop: a violation is the same 409.
export async function addCandidateToJob({ db, actor, jobId, passportId }) {
    const stored = await resolveCandidatePassportId({ db, passportId });
    if (!stored) throw new CandidateError(404, "CANDIDATE_NOT_FOUND", "Candidate not found");
    try {
        return await db.$transaction(async (tx) => {
            const job = await lockJob(tx, jobId, "share");
            requireProcessing(job);
            const locked = await tx.$queryRaw`SELECT "passport_id" FROM "candidate" WHERE "passport_id" = ${stored} FOR UPDATE`;
            if (!locked.length) throw new CandidateError(404, "CANDIDATE_NOT_FOUND", "Candidate not found");

            const active = await tx.jobCandidate.findFirst({ where: { passportId: stored, isActive: true }, select: { jobId: true, job: { select: { jobCode: true } } } });
            if (active?.jobId === jobId) throw new CandidateError(409, "CANDIDATE_ALREADY_IN_JOB", `This candidate is already assigned to ${job.jobCode}.`);
            if (active) throw new CandidateError(409, "CANDIDATE_ON_ACTIVE_JOB", `This candidate is already on the PROCESSING job ${active.job.jobCode}. Complete or cancel that job, or remove the candidate from it, first.`);

            const existing = await tx.jobCandidate.findUnique({ where: { jobId_passportId: { jobId, passportId: stored } }, select: { releasedAt: true } });
            const now = new Date();
            if (existing) {
                // Removed earlier from this same job: the same membership row is reused.
                await tx.jobCandidate.update({ where: { jobId_passportId: { jobId, passportId: stored } }, data: { isActive: true, releasedAt: null, assignedAt: now, assignedBy: actor.adminId } });
            } else {
                await tx.jobCandidate.create({ data: { jobId, passportId: stored, assignedAt: now, assignedBy: actor.adminId, isActive: true } });
            }
            await tx.auditLog.create({
                data: auditRow({ actor, action: JOB_AUDIT_ACTION.ADD_CANDIDATE, passportId: stored, previousStatus: "NOT_ASSIGNED", newStatus: "ASSIGNED", reason: `Assigned to ${job.jobCode}`, newValue: JSON.stringify({ jobId, jobCode: job.jobCode }) }),
            });
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
