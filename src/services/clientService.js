import { CandidateError, listPagination } from "./candidateService.js";
import { JOB_STATUS } from "./jobAssignmentReader.js";
import {
    ENTITY_STATUS,
    JOB_ROW_SELECT,
    MAX_DETAIL_JOBS,
    auditRow,
    changeSet,
    isObject,
    isUniqueViolation,
    iso,
    jobRow,
    parseEmail,
    parsePhone,
    parseText,
    searchWords,
    statusOf,
} from "./agentService.js";

// Client Management (Admin > Client Management). Docs/AGENT_CLIENT_MANAGEMENT.md.
//
// A Client is the EMPLOYER / customer organisation (table "client", formerly
// "company"; NOT the legacy candidate "client" of the Documents area). It has
// ONE responsible Agent (client.agent_id -> agent.id, by immutable id, never by
// name) and many Jobs. Never hard-deleted: ACTIVE or INACTIVE (client.is_active).
// An INACTIVE Client keeps its Jobs and its Agent link but cannot get a new Job.
//
// Country: a Client has no country column; it is its Agent's country, so there is
// one source of truth (agent.country_code) and nothing to drift.
//
// Changing a Client's Agent is its own action. Existing Jobs keep the Agent they
// were created with (job.responsible_agent_id is the job's own record), so
// history is never rewritten; only NEW jobs use the new Agent.
//
// Roles (the routes check them): ADMIN, MANAGER manage; the other roles have no
// access to the Clients API.

export const CLIENT_AUDIT_ACTION = Object.freeze({
    CREATED: "CLIENT_CREATED",
    UPDATED: "CLIENT_UPDATED",
    AGENT_CHANGED: "CLIENT_AGENT_CHANGED",
    STATUS_CHANGED: "CLIENT_STATUS_CHANGED",
});

const MAX_NAME_LENGTH = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DUPLICATE_MESSAGE = "A client with this name already exists.";

// ---------------------------------------------------------------- parsing

function parseAgentId(body, errors) {
    if (typeof body.agentId !== "string" || !UUID.test(body.agentId)) {
        errors.push({ field: "agentId", message: body.agentId === undefined ? "is required" : "must be an ID from the list" });
        return undefined;
    }
    return body.agentId.toLowerCase();
}

// POST /api/admin/client-management { name, agentId, contactPerson?, ... }
export function parseCreateClientBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const values = { name: parseText(body, "name", errors, { required: true, max: MAX_NAME_LENGTH }) };
    if (body.name === undefined) errors.push({ field: "name", message: "is required" });
    values.agentId = parseAgentId(body, errors);
    values.contactPerson = parseText(body, "contactPerson", errors, { max: MAX_NAME_LENGTH }) ?? null;
    values.contactNumber = parsePhone(body, "contactNumber", errors) ?? null;
    values.whatsappNumber = parsePhone(body, "whatsappNumber", errors) ?? null;
    values.email = parseEmail(body, "email", errors) ?? null;
    values.address = parseText(body, "address", errors) ?? null;
    return errors.length ? { errors } : { values };
}

// PATCH /api/admin/client-management/:clientId. The id is immutable; the Agent
// and the status have their own actions.
export function parseUpdateClientBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const values = {};
    if (body.name !== undefined) values.name = parseText(body, "name", errors, { required: true, max: MAX_NAME_LENGTH });
    if (body.contactPerson !== undefined) values.contactPerson = parseText(body, "contactPerson", errors, { max: MAX_NAME_LENGTH });
    if (body.contactNumber !== undefined) values.contactNumber = parsePhone(body, "contactNumber", errors);
    if (body.whatsappNumber !== undefined) values.whatsappNumber = parsePhone(body, "whatsappNumber", errors);
    if (body.email !== undefined) values.email = parseEmail(body, "email", errors);
    if (body.address !== undefined) values.address = parseText(body, "address", errors);
    for (const field of ["id", "clientId", "agentId", "status", "isActive", "createdAt", "updatedAt"]) {
        if (body[field] !== undefined) {
            const message = field === "status" ? "is changed with the status action" : field === "agentId" ? "is changed with the change-agent action" : "cannot be changed";
            errors.push({ field, message });
        }
    }
    if (!errors.length && Object.keys(values).length === 0) errors.push({ field: "body", message: "must contain at least one field to change" });
    return errors.length ? { errors } : { values };
}

// PATCH /api/admin/client-management/:clientId/agent { agentId }
export function parseChangeAgentBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const agentId = parseAgentId(body, errors);
    return errors.length ? { errors } : { values: { agentId } };
}

// ---------------------------------------------------------------- views

const CLIENT_SELECT = Object.freeze({
    id: true, name: true, agentId: true, isActive: true, contactPerson: true, contactNumber: true, whatsappNumber: true,
    email: true, address: true, createdAt: true, updatedAt: true,
    agent: { select: { id: true, name: true, countryCode: true, isActive: true } },
});

const agentRef = (agent) => (agent ? { agentId: agent.id, name: agent.name, countryCode: agent.countryCode, status: statusOf(agent.isActive) } : null);

const clientView = (row) => ({
    clientId: row.id,
    name: row.name,
    status: statusOf(row.isActive),
    // The Agent's country (a Client has none of its own); null while no Agent is assigned.
    countryCode: row.agent?.countryCode ?? null,
    agent: agentRef(row.agent),
    contactPerson: row.contactPerson ?? null,
    contactNumber: row.contactNumber ?? null,
    whatsappNumber: row.whatsappNumber ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
});

function listWhere(params) {
    const parts = [];
    if (params.status) parts.push({ isActive: params.status === ENTITY_STATUS.ACTIVE });
    if (params.agentId) parts.push({ agentId: params.agentId });
    if (params.country) parts.push({ agent: { is: { countryCode: params.country } } });
    if (params.search) {
        parts.push({
            AND: searchWords(params.search).map((word) => ({
                OR: [{ name: { contains: word, mode: "insensitive" } }, { contactPerson: { contains: word, mode: "insensitive" } }],
            })),
        });
    }
    return parts.length ? { AND: parts } : {};
}

async function jobCounts(db, clientIds) {
    const groups = await db.job.groupBy({ by: ["clientId", "status"], where: { clientId: { in: clientIds } }, _count: { _all: true } });
    return (clientId) => {
        const of = (status) => groups.find((group) => group.clientId === clientId && group.status === status)?._count._all ?? 0;
        return { processingJobs: of(JOB_STATUS.PROCESSING), completedJobs: of(JOB_STATUS.COMPLETED), cancelledJobs: of(JOB_STATUS.CANCELLED) };
    };
}

// GET /api/admin/client-management
export async function listClients({ db, params }) {
    const where = listWhere(params);
    const [total, rows, countries] = await Promise.all([
        db.client.count({ where }),
        db.client.findMany({
            where, select: CLIENT_SELECT, orderBy: [{ name: "asc" }, { id: "asc" }],
            skip: (params.page - 1) * params.pageSize, take: params.pageSize,
        }),
        db.agent.findMany({ distinct: ["countryCode"], select: { countryCode: true }, orderBy: { countryCode: "asc" } }),
    ]);
    const counts = await jobCounts(db, rows.map((row) => row.id));
    return {
        items: rows.map((row) => ({ ...clientView(row), ...counts(row.id) })),
        pagination: listPagination(params, total),
        filters: { search: params.search ?? null, country: params.country ?? null, status: params.status ?? null, agentId: params.agentId ?? null },
        countries: countries.map((row) => row.countryCode),
    };
}

// GET /api/admin/client-management/:clientId
export async function getClient({ db, clientId }) {
    const row = await db.client.findUnique({ where: { id: clientId }, select: CLIENT_SELECT });
    if (!row) throw new CandidateError(404, "CLIENT_NOT_FOUND", "Client not found");
    const [jobsByStatus, counts, candidateCounts] = await Promise.all([
        Promise.all(Object.values(JOB_STATUS).map((status) => db.job.findMany({
            where: { clientId, status }, select: JOB_ROW_SELECT,
            orderBy: [{ createdAt: "desc" }, { jobCode: "desc" }], take: MAX_DETAIL_JOBS,
        }))),
        jobCounts(db, [clientId]),
        db.jobCandidate.groupBy({ by: ["jobId"], where: { isActive: true, job: { clientId } }, _count: { _all: true } }),
    ]);
    const withCandidates = (job) => ({ ...jobRow(job), activeCandidates: candidateCounts.find((group) => group.jobId === job.id)?._count._all ?? 0 });
    const [processing, completed, cancelled] = jobsByStatus;
    return {
        ...clientView(row),
        ...counts(clientId),
        jobs: { processing: processing.map(withCandidates), completed: completed.map(withCandidates), cancelled: cancelled.map(withCandidates) },
        jobsShownLimit: MAX_DETAIL_JOBS,
    };
}

// ---------------------------------------------------------------- writing

// The Agent a Client is assigned to must exist and be ACTIVE. Share-locked so it
// cannot be made inactive between this check and the write (agentService.js
// setAgentStatus locks the row FOR UPDATE).
async function requireActiveAgent(tx, agentId) {
    await tx.$queryRaw`SELECT "id" FROM "agent" WHERE "id" = ${agentId}::uuid FOR SHARE`;
    const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { id: true, name: true, isActive: true, countryCode: true } });
    if (!agent) throw new CandidateError(400, "AGENT_NOT_FOUND", "The selected agent does not exist.");
    if (!agent.isActive) throw new CandidateError(409, "AGENT_INACTIVE", "The selected agent is inactive and cannot be assigned to a client.");
    return agent;
}

async function lockClient(tx, clientId) {
    const rows = await tx.$queryRaw`SELECT "id" FROM "client" WHERE "id" = ${clientId}::uuid FOR UPDATE`;
    if (!rows.length) throw new CandidateError(404, "CLIENT_NOT_FOUND", "Client not found");
}

// POST /api/admin/client-management
export async function createClient({ db, actor, values }) {
    try {
        const id = await db.$transaction(async (tx) => {
            const agent = await requireActiveAgent(tx, values.agentId);
            const row = await tx.client.create({ data: values, select: { id: true } });
            await tx.auditLog.create({
                data: auditRow({
                    actor, action: CLIENT_AUDIT_ACTION.CREATED, previousStatus: "NONE", newStatus: ENTITY_STATUS.ACTIVE, reason: "Client created",
                    newValue: JSON.stringify({ clientId: row.id, name: values.name, agentId: agent.id }),
                }),
            });
            return row.id;
        });
        return await getClient({ db, clientId: id });
    } catch (error) {
        if (isUniqueViolation(error)) throw new CandidateError(409, "DUPLICATE", DUPLICATE_MESSAGE);
        throw error;
    }
}

const CLIENT_CHANGE_FIELDS = ["name", "contactPerson", "contactNumber", "whatsappNumber", "email", "address"];
const CLIENT_REDACTED = ["contactPerson", "contactNumber", "whatsappNumber", "email", "address"];

// PATCH /api/admin/client-management/:clientId. Only the given fields change; the
// id (and so every job's client_id) never does, so renaming a Client breaks nothing.
export async function updateClient({ db, actor, clientId, values }) {
    try {
        await db.$transaction(async (tx) => {
            await lockClient(tx, clientId);
            const before = await tx.client.findUnique({ where: { id: clientId }, select: CLIENT_SELECT });
            const { previous, next, changed } = changeSet(before, values, CLIENT_CHANGE_FIELDS, { redact: CLIENT_REDACTED });
            if (!changed.length) return;
            await tx.client.update({ where: { id: clientId }, data: values });
            await tx.auditLog.create({
                data: auditRow({
                    actor, action: CLIENT_AUDIT_ACTION.UPDATED, previousStatus: statusOf(before.isActive), newStatus: statusOf(before.isActive),
                    reason: `Client updated: ${changed.join(", ")}`,
                    previousValue: JSON.stringify({ clientId, ...previous }), newValue: JSON.stringify({ clientId, ...next }),
                }),
            });
        });
        return await getClient({ db, clientId });
    } catch (error) {
        if (isUniqueViolation(error)) throw new CandidateError(409, "DUPLICATE", DUPLICATE_MESSAGE);
        throw error;
    }
}

// PATCH /api/admin/client-management/:clientId/agent. The new Agent must be
// ACTIVE. Existing jobs keep their own responsible Agent (option "preserve the
// job's explicit Agent"): nothing in job is rewritten. A change of country is
// allowed; the Client's country is simply its new Agent's.
export async function changeClientAgent({ db, actor, clientId, agentId }) {
    await db.$transaction(async (tx) => {
        await lockClient(tx, clientId);
        const before = await tx.client.findUnique({ where: { id: clientId }, select: { agentId: true, isActive: true } });
        if (before.agentId === agentId) return;
        const agent = await requireActiveAgent(tx, agentId);
        await tx.client.update({ where: { id: clientId }, data: { agentId } });
        await tx.auditLog.create({
            data: auditRow({
                actor, action: CLIENT_AUDIT_ACTION.AGENT_CHANGED, previousStatus: statusOf(before.isActive), newStatus: statusOf(before.isActive),
                reason: `Client moved to agent ${agent.name}`,
                previousValue: JSON.stringify({ clientId, agentId: before.agentId }), newValue: JSON.stringify({ clientId, agentId }),
            }),
        });
    });
    return getClient({ db, clientId });
}

// PATCH /api/admin/client-management/:clientId/status. INACTIVE is refused while
// the client has PROCESSING jobs; activating needs an ACTIVE Agent (a client whose
// Agent is inactive stays inactive until an active Agent is assigned). The row
// lock serialises this with job creation (jobService.js share-locks the client).
export async function setClientStatus({ db, actor, clientId, status }) {
    await db.$transaction(async (tx) => {
        await lockClient(tx, clientId);
        const before = await tx.client.findUnique({ where: { id: clientId }, select: { isActive: true, agent: { select: { isActive: true } } } });
        const wantActive = status === ENTITY_STATUS.ACTIVE;
        if (before.isActive === wantActive) return;
        if (wantActive && !before.agent?.isActive) {
            throw new CandidateError(409, "AGENT_INACTIVE", "This client has no active agent. Assign an active agent before activating the client.");
        }
        if (!wantActive) {
            const processing = await tx.job.count({ where: { clientId, status: JOB_STATUS.PROCESSING } });
            if (processing > 0) {
                throw new CandidateError(409, "CLIENT_HAS_PROCESSING_JOBS", `This client has ${processing} PROCESSING job${processing === 1 ? "" : "s"}. Complete or cancel ${processing === 1 ? "it" : "them"} before making the client inactive.`);
            }
        }
        await tx.client.update({ where: { id: clientId }, data: { isActive: wantActive } });
        await tx.auditLog.create({
            data: auditRow({
                actor, action: CLIENT_AUDIT_ACTION.STATUS_CHANGED, previousStatus: statusOf(before.isActive), newStatus: status,
                reason: `Client ${wantActive ? "activated" : "made inactive"}`,
                previousValue: JSON.stringify({ clientId, status: statusOf(before.isActive) }), newValue: JSON.stringify({ clientId, status }),
            }),
        });
    });
    return getClient({ db, clientId });
}
