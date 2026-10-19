import crypto from "node:crypto";

import { CandidateError, listPagination } from "./candidateService.js";
import { JOB_STATUS } from "./jobAssignmentReader.js";
import { normalizeCountryCode } from "../utils/countries.js";
import { normalizePhoneNumber } from "../utils/phoneNumber.js";

// Agent Management (Admin > Agents). Docs/AGENT_CLIENT_MANAGEMENT.md.
//
// An Agent is a BUSINESS entity (the overseas recruiting partner), never a
// login: it has no link to the user table. One Agent belongs to ONE country and
// manages MANY Clients (client.agent_id). Agents are never hard-deleted: they
// are ACTIVE or INACTIVE (agent.is_active). An INACTIVE Agent keeps its history
// but cannot be given a new Client or a new Job.
//
// Roles (the routes check them): ADMIN, MANAGER manage; the other roles have no
// access to the Agents API.

export const ENTITY_STATUS = Object.freeze({ ACTIVE: "ACTIVE", INACTIVE: "INACTIVE" });

export const AGENT_AUDIT_ACTION = Object.freeze({
    CREATED: "AGENT_CREATED",
    UPDATED: "AGENT_UPDATED",
    STATUS_CHANGED: "AGENT_STATUS_CHANGED",
});

export const AGENT_LIST_PAGE_SIZE = 25;
const MAX_NAME_LENGTH = 120;
const MAX_TEXT_LENGTH = 300;
const MAX_NOTES_LENGTH = 1000;
const MAX_JOBS_SHOWN = 50;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const isValidUuid = (value) => typeof value === "string" && UUID_PATTERN.test(value);
export const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export const isUniqueViolation = (error) => error?.code === "P2002";
export const iso = (value) => (value ? value.toISOString() : null);
export const statusOf = (isActive) => (isActive ? ENTITY_STATUS.ACTIVE : ENTITY_STATUS.INACTIVE);

// ---------------------------------------------------------------- shared parsing

// A required or optional text value. Optional fields: null / empty clears.
// Returns undefined when the field is absent (or invalid, with an error added).
export function parseText(body, field, errors, { required = false, max = MAX_TEXT_LENGTH, multiline = false } = {}) {
    const raw = body[field];
    if (raw === undefined) return undefined;
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
        if (required) errors.push({ field, message: "is required" });
        return required ? undefined : null;
    }
    if (typeof raw !== "string") {
        errors.push({ field, message: "must be text" });
        return undefined;
    }
    const value = multiline ? raw.trim() : raw.trim().replace(/\s+/g, " ");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        errors.push({ field, message: "must not contain control characters" });
        return undefined;
    }
    if (value.length > max) {
        errors.push({ field, message: `must be at most ${max} characters` });
        return undefined;
    }
    return value;
}

// Stored in the project's normalised phone form (94771234567), like candidates.
export function parsePhone(body, field, errors) {
    const value = parseText(body, field, errors, { max: 30 });
    if (value === undefined || value === null) return value;
    const normalized = normalizePhoneNumber(value);
    if (!normalized) {
        errors.push({ field, message: "must be a phone number (for example 0771234567 or +94771234567)" });
        return undefined;
    }
    return normalized;
}

export function parseEmail(body, field, errors) {
    const value = parseText(body, field, errors, { max: 254 });
    if (value === undefined || value === null) return value;
    if (!EMAIL_PATTERN.test(value)) {
        errors.push({ field, message: "must be an email address" });
        return undefined;
    }
    return value.toLowerCase();
}

export function parseStatus(body, errors, field = "status") {
    const value = body[field];
    if (value !== ENTITY_STATUS.ACTIVE && value !== ENTITY_STATUS.INACTIVE) {
        errors.push({ field, message: "must be ACTIVE or INACTIVE" });
        return undefined;
    }
    return value;
}

function singleQuery(query, field, errors) {
    const value = query[field];
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string") {
        errors.push({ field, message: "must be given once" });
        return undefined;
    }
    return value;
}

// page, search, status and country (+ one optional id filter) for the Agent and Client lists.
export function parseListQuery(query, { idFilter } = {}) {
    const errors = [];
    const params = { page: 1, pageSize: AGENT_LIST_PAGE_SIZE };
    const page = singleQuery(query, "page", errors);
    if (page !== undefined) {
        if (/^\d{1,5}$/.test(page) && Number(page) >= 1) params.page = Number(page);
        else errors.push({ field: "page", message: "must be a whole number from 1 to 99999" });
    }
    const search = singleQuery(query, "search", errors);
    if (search !== undefined) {
        const trimmed = search.trim();
        if (trimmed.length > 100) errors.push({ field: "search", message: "must be at most 100 characters" });
        else if (trimmed) params.search = trimmed;
    }
    const status = singleQuery(query, "status", errors);
    if (status !== undefined) {
        if (Object.hasOwn(ENTITY_STATUS, status)) params.status = status;
        else errors.push({ field: "status", message: "must be ACTIVE or INACTIVE" });
    }
    const country = singleQuery(query, "country", errors);
    if (country !== undefined) {
        const code = normalizeCountryCode(country);
        if (code) params.country = code;
        else errors.push({ field: "country", message: "must be a 2-letter country code (e.g. LK)" });
    }
    if (idFilter) {
        const id = singleQuery(query, idFilter, errors);
        if (id !== undefined) {
            if (isValidUuid(id)) params[idFilter] = id.toLowerCase();
            else errors.push({ field: idFilter, message: "must be an ID" });
        }
    }
    return errors.length ? { errors } : { params };
}

export const searchWords = (search) => search.split(/\s+/).filter(Boolean).slice(0, 5);

export const auditRow = ({ actor, action, previousStatus, newStatus, reason = null, previousValue = null, newValue = null }) => ({
    auditId: crypto.randomUUID(), adminId: actor.adminId, action, passportId: null, previousStatus, newStatus, reason, previousValue, newValue,
});

// What changed, for the audit log. Contact details are personal data: only the
// FACT that they changed is recorded, never their values.
export function changeSet(before, after, fields, { redact = [] } = {}) {
    const previous = {};
    const next = {};
    for (const field of fields) {
        if (after[field] === undefined || after[field] === before[field]) continue;
        if (redact.includes(field)) {
            previous[field] = "(changed)";
            next[field] = "(changed)";
        } else {
            previous[field] = before[field] ?? null;
            next[field] = after[field] ?? null;
        }
    }
    return { previous, next, changed: Object.keys(next) };
}

// ---------------------------------------------------------------- parsing (Agent)

// POST /api/admin/agents
export function parseCreateAgentBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const values = { name: parseText(body, "name", errors, { required: true, max: MAX_NAME_LENGTH }) };
    if (body.name === undefined) errors.push({ field: "name", message: "is required" });
    const country = normalizeCountryCode(body.countryCode);
    if (!country) errors.push({ field: "countryCode", message: body.countryCode === undefined ? "is required" : "must be a valid 2-letter country code (e.g. LK)" });
    values.countryCode = country;
    values.contactNumber = parsePhone(body, "contactNumber", errors) ?? null;
    values.whatsappNumber = parsePhone(body, "whatsappNumber", errors) ?? null;
    values.email = parseEmail(body, "email", errors) ?? null;
    values.address = parseText(body, "address", errors) ?? null;
    values.notes = parseText(body, "notes", errors, { max: MAX_NOTES_LENGTH, multiline: true }) ?? null;
    if (body.status !== undefined) values.status = parseStatus(body, errors);
    return errors.length ? { errors } : { values };
}

// PATCH /api/admin/agents/:agentId. The id is immutable; status has its own route.
export function parseUpdateAgentBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const values = {};
    if (body.name !== undefined) values.name = parseText(body, "name", errors, { required: true, max: MAX_NAME_LENGTH });
    if (body.countryCode !== undefined) {
        const country = normalizeCountryCode(body.countryCode);
        if (country) values.countryCode = country;
        else errors.push({ field: "countryCode", message: "must be a valid 2-letter country code (e.g. LK)" });
    }
    if (body.contactNumber !== undefined) values.contactNumber = parsePhone(body, "contactNumber", errors);
    if (body.whatsappNumber !== undefined) values.whatsappNumber = parsePhone(body, "whatsappNumber", errors);
    if (body.email !== undefined) values.email = parseEmail(body, "email", errors);
    if (body.address !== undefined) values.address = parseText(body, "address", errors);
    if (body.notes !== undefined) values.notes = parseText(body, "notes", errors, { max: MAX_NOTES_LENGTH, multiline: true });
    for (const field of ["id", "agentId", "status", "isActive", "createdAt", "updatedAt"]) {
        if (body[field] !== undefined) errors.push({ field, message: field === "status" ? "is changed with the status action" : "cannot be changed" });
    }
    if (!errors.length && Object.keys(values).length === 0) errors.push({ field: "body", message: "must contain at least one field to change" });
    return errors.length ? { errors } : { values };
}

// PATCH /api/admin/agents/:agentId/status and /client-management/:id/status { status }
export function parseStatusBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const status = parseStatus(body, errors);
    return errors.length ? { errors } : { values: { status } };
}

// ---------------------------------------------------------------- views

export const AGENT_SELECT = Object.freeze({
    id: true, name: true, countryCode: true, isActive: true, contactNumber: true, whatsappNumber: true,
    email: true, address: true, notes: true, createdAt: true, updatedAt: true,
});

export const agentView = (row) => ({
    agentId: row.id,
    name: row.name,
    countryCode: row.countryCode,
    status: statusOf(row.isActive),
    contactNumber: row.contactNumber ?? null,
    whatsappNumber: row.whatsappNumber ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    notes: row.notes ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
});

function listWhere(params) {
    const parts = [];
    if (params.status) parts.push({ isActive: params.status === ENTITY_STATUS.ACTIVE });
    if (params.country) parts.push({ countryCode: params.country });
    if (params.search) parts.push({ AND: searchWords(params.search).map((word) => ({ name: { contains: word, mode: "insensitive" } })) });
    return parts.length ? { AND: parts } : {};
}

const jobCount = (groups, match, status) => groups.find((group) => match(group) && group.status === status)?._count._all ?? 0;

// Counts come from the relational data (clients and jobs), for the agents given.
async function agentCounts(db, agentIds) {
    const [clients, jobs] = await Promise.all([
        db.client.groupBy({ by: ["agentId"], where: { agentId: { in: agentIds }, isActive: true }, _count: { _all: true } }),
        db.job.groupBy({ by: ["responsibleAgentId", "status"], where: { responsibleAgentId: { in: agentIds } }, _count: { _all: true } }),
    ]);
    return (agentId) => {
        const of = (status) => jobCount(jobs, (group) => group.responsibleAgentId === agentId, status);
        return {
            activeClients: clients.find((group) => group.agentId === agentId)?._count._all ?? 0,
            processingJobs: of(JOB_STATUS.PROCESSING),
            completedJobs: of(JOB_STATUS.COMPLETED),
            cancelledJobs: of(JOB_STATUS.CANCELLED),
        };
    };
}

// GET /api/admin/agents
export async function listAgents({ db, params }) {
    const where = listWhere(params);
    const [total, rows, countries] = await Promise.all([
        db.agent.count({ where }),
        db.agent.findMany({
            where, select: AGENT_SELECT, orderBy: [{ name: "asc" }, { id: "asc" }],
            skip: (params.page - 1) * params.pageSize, take: params.pageSize,
        }),
        db.agent.findMany({ distinct: ["countryCode"], select: { countryCode: true }, orderBy: { countryCode: "asc" } }),
    ]);
    const counts = await agentCounts(db, rows.map((row) => row.id));
    return {
        items: rows.map((row) => ({ ...agentView(row), ...counts(row.id) })),
        pagination: listPagination(params, total),
        filters: { search: params.search ?? null, country: params.country ?? null, status: params.status ?? null },
        countries: countries.map((row) => row.countryCode),
    };
}

// GET /api/admin/agent-options: every agent (all statuses, not paged), for the
// selectors and filters of the Client Management screens. Which one is
// selectable for a NEW assignment is decided by the status the screen reads here
// and re-checked by the server on every write.
export async function listAgentOptions({ db }) {
    const rows = await db.agent.findMany({ select: { id: true, name: true, countryCode: true, isActive: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
    return { agents: rows.map((row) => ({ agentId: row.id, name: row.name, countryCode: row.countryCode, status: statusOf(row.isActive) })) };
}

export const JOB_ROW_SELECT = Object.freeze({
    id: true, jobCode: true, companyJobId: true, status: true, createdAt: true, completedAt: true, cancelledAt: true,
    client: { select: { id: true, name: true } },
    jobType: { select: { id: true, name: true } },
    responsibleAgent: { select: { id: true, name: true } },
});

export const jobRow = (job) => ({
    jobId: job.id,
    jobCode: job.jobCode,
    companyJobId: job.companyJobId ?? null,
    status: job.status,
    client: { id: job.client.id, name: job.client.name },
    jobType: { id: job.jobType.id, name: job.jobType.name },
    responsibleAgent: { id: job.responsibleAgent.id, name: job.responsibleAgent.name },
    createdAt: iso(job.createdAt),
    completedAt: iso(job.completedAt),
    cancelledAt: iso(job.cancelledAt),
});

export const MAX_DETAIL_JOBS = MAX_JOBS_SHOWN;

// GET /api/admin/agents/:agentId
export async function getAgent({ db, agentId }) {
    const row = await db.agent.findUnique({ where: { id: agentId }, select: AGENT_SELECT });
    if (!row) throw new CandidateError(404, "AGENT_NOT_FOUND", "Agent not found");
    const [clients, jobsByStatus, counts, clientJobs] = await Promise.all([
        db.client.findMany({ where: { agentId }, select: { id: true, name: true, isActive: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
        Promise.all(Object.values(JOB_STATUS).map((status) => db.job.findMany({
            where: { responsibleAgentId: agentId, status }, select: JOB_ROW_SELECT,
            orderBy: [{ createdAt: "desc" }, { jobCode: "desc" }], take: MAX_JOBS_SHOWN,
        }))),
        agentCounts(db, [agentId]),
        db.job.groupBy({ by: ["clientId"], where: { responsibleAgentId: agentId, status: JOB_STATUS.PROCESSING }, _count: { _all: true } }),
    ]);
    const [processing, completed, cancelled] = jobsByStatus;
    return {
        ...agentView(row),
        ...counts(agentId),
        clients: clients.map((client) => ({
            clientId: client.id,
            name: client.name,
            status: statusOf(client.isActive),
            processingJobs: clientJobs.find((group) => group.clientId === client.id)?._count._all ?? 0,
        })),
        jobs: { processing: processing.map(jobRow), completed: completed.map(jobRow), cancelled: cancelled.map(jobRow) },
        jobsShownLimit: MAX_JOBS_SHOWN,
    };
}

// ---------------------------------------------------------------- writing

const DUPLICATE_MESSAGE = "An agent with this name already exists in this country.";

// POST /api/admin/agents
export async function createAgent({ db, actor, values }) {
    try {
        const id = await db.$transaction(async (tx) => {
            const { status, ...fields } = values;
            const row = await tx.agent.create({ data: { ...fields, isActive: status !== ENTITY_STATUS.INACTIVE }, select: { id: true } });
            await tx.auditLog.create({
                data: auditRow({
                    actor, action: AGENT_AUDIT_ACTION.CREATED, previousStatus: "NONE", newStatus: status ?? ENTITY_STATUS.ACTIVE, reason: "Agent created",
                    newValue: JSON.stringify({ agentId: row.id, name: values.name, countryCode: values.countryCode }),
                }),
            });
            return row.id;
        });
        return await getAgent({ db, agentId: id });
    } catch (error) {
        if (isUniqueViolation(error)) throw new CandidateError(409, "DUPLICATE", DUPLICATE_MESSAGE);
        throw error;
    }
}

async function lockAgent(tx, agentId) {
    const rows = await tx.$queryRaw`SELECT "id" FROM "agent" WHERE "id" = ${agentId}::uuid FOR UPDATE`;
    if (!rows.length) throw new CandidateError(404, "AGENT_NOT_FOUND", "Agent not found");
}

const processingJobsOf = (tx, agentId) => tx.job.count({ where: { responsibleAgentId: agentId, status: JOB_STATUS.PROCESSING } });

const AGENT_CHANGE_FIELDS = ["name", "countryCode", "contactNumber", "whatsappNumber", "email", "address", "notes"];
const AGENT_REDACTED = ["contactNumber", "whatsappNumber", "email", "address", "notes"];

// PATCH /api/admin/agents/:agentId. Only the given fields change. The id never
// changes, so client.agent_id and job.responsible_agent_id stay valid. The
// country cannot change while the agent has PROCESSING jobs (each job copied the
// country at creation, and they must keep matching).
export async function updateAgent({ db, actor, agentId, values }) {
    try {
        await db.$transaction(async (tx) => {
            await lockAgent(tx, agentId);
            const before = await tx.agent.findUnique({ where: { id: agentId }, select: AGENT_SELECT });
            if (values.countryCode && values.countryCode !== before.countryCode && (await processingJobsOf(tx, agentId)) > 0) {
                throw new CandidateError(409, "AGENT_HAS_PROCESSING_JOBS", "The country cannot be changed while this agent has PROCESSING jobs. Complete or cancel them first.");
            }
            const { previous, next, changed } = changeSet(before, values, AGENT_CHANGE_FIELDS, { redact: AGENT_REDACTED });
            if (!changed.length) return;
            await tx.agent.update({ where: { id: agentId }, data: values });
            await tx.auditLog.create({
                data: auditRow({
                    actor, action: AGENT_AUDIT_ACTION.UPDATED, previousStatus: statusOf(before.isActive), newStatus: statusOf(before.isActive),
                    reason: `Agent updated: ${changed.join(", ")}`,
                    previousValue: JSON.stringify({ agentId, ...previous }), newValue: JSON.stringify({ agentId, ...next }),
                }),
            });
        });
        return await getAgent({ db, agentId });
    } catch (error) {
        if (isUniqueViolation(error)) throw new CandidateError(409, "DUPLICATE", DUPLICATE_MESSAGE);
        throw error;
    }
}

// PATCH /api/admin/agents/:agentId/status. INACTIVE is refused while the agent
// has PROCESSING jobs (they would be left with an inactive responsible agent);
// the row lock makes this check race-free against a job being created for the
// agent (jobService.js share-locks the agent). Repeating the current status is a no-op.
export async function setAgentStatus({ db, actor, agentId, status }) {
    await db.$transaction(async (tx) => {
        await lockAgent(tx, agentId);
        const before = await tx.agent.findUnique({ where: { id: agentId }, select: { isActive: true } });
        const wantActive = status === ENTITY_STATUS.ACTIVE;
        if (before.isActive === wantActive) return;
        if (!wantActive) {
            const processing = await processingJobsOf(tx, agentId);
            if (processing > 0) {
                throw new CandidateError(409, "AGENT_HAS_PROCESSING_JOBS", `This agent has ${processing} PROCESSING job${processing === 1 ? "" : "s"}. Complete or cancel ${processing === 1 ? "it" : "them"} before making the agent inactive.`);
            }
        }
        await tx.agent.update({ where: { id: agentId }, data: { isActive: wantActive } });
        await tx.auditLog.create({
            data: auditRow({
                actor, action: AGENT_AUDIT_ACTION.STATUS_CHANGED, previousStatus: statusOf(before.isActive), newStatus: status,
                reason: `Agent ${wantActive ? "activated" : "made inactive"}`,
                previousValue: JSON.stringify({ agentId, status: statusOf(before.isActive) }), newValue: JSON.stringify({ agentId, status }),
            }),
        });
    });
    return getAgent({ db, agentId });
}
