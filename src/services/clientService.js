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
    parseIdList,
    parsePhone,
    parseText,
    searchWords,
    statusOf,
} from "./agentService.js";

// Client Management (Admin > Client Management). Docs/AGENT_CLIENT_MANAGEMENT.md.
//
// A Client is the EMPLOYER / customer organisation (table "client", formerly
// "company"; NOT the legacy candidate "client" of the Documents area). It works
// with MANY Agents and an Agent with many Clients (agent_client, by immutable id,
// never by name; migration 20261026120000_agent_client_many_to_many), and has many
// Jobs. Never hard-deleted: ACTIVE or INACTIVE (client.is_active). An INACTIVE
// Client keeps its Jobs and its Agent links but cannot get a new Job.
//
// Country: a Client has no country column. Its Agents' countries are shown (more
// than one when its Agents are in different countries); a Job's To Country is its
// own responsible Agent's country, copied when the Job is created (jobService.js).
// No Agent is ever "the first" or "the main" one.
//
// Agents are edited as a full list (agentIds, replacement), in one transaction. A
// Client keeps at least one Agent. Existing Jobs keep the Agent they were created
// with (job.responsible_agent_id is the job's own record), so history is never
// rewritten when links change.
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

// POST /api/admin/client-management { name, agentIds, contactPerson?, ... }. At least one Agent.
// (The single agentId of the previous release is still accepted: it means agentIds: [agentId].)
export function parseCreateClientBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const values = { name: parseText(body, "name", errors, { required: true, max: MAX_NAME_LENGTH }) };
    if (body.name === undefined) errors.push({ field: "name", message: "is required" });
    if (body.agentIds !== undefined) values.agentIds = parseIdList(body, "agentIds", errors, { min: 1 });
    else if (body.agentId !== undefined) {
        const agentId = parseAgentId(body, errors);
        if (agentId) values.agentIds = [agentId];
    } else errors.push({ field: "agentIds", message: "is required (at least one agent)" });
    values.contactPerson = parseText(body, "contactPerson", errors, { max: MAX_NAME_LENGTH }) ?? null;
    values.contactNumber = parsePhone(body, "contactNumber", errors) ?? null;
    values.whatsappNumber = parsePhone(body, "whatsappNumber", errors) ?? null;
    values.email = parseEmail(body, "email", errors) ?? null;
    values.address = parseText(body, "address", errors) ?? null;
    return errors.length ? { errors } : { values };
}

// PATCH /api/admin/client-management/:clientId. The id is immutable and the status has
// its own action. agentIds (optional, at least one): the Client's Agents become exactly
// this list (replacement).
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
    if (body.agentIds !== undefined) {
        const agentIds = parseIdList(body, "agentIds", errors, { min: 1 });
        if (agentIds !== undefined) values.agentIds = agentIds;
    }
    for (const field of ["id", "clientId", "agentId", "status", "isActive", "createdAt", "updatedAt"]) {
        if (body[field] !== undefined) {
            const message = field === "status" ? "is changed with the status action" : field === "agentId" ? "is replaced by agentIds (the full list of the client's agents)" : "cannot be changed";
            errors.push({ field, message });
        }
    }
    if (!errors.length && Object.keys(values).length === 0) errors.push({ field: "body", message: "must contain at least one field to change" });
    return errors.length ? { errors } : { values };
}

// PATCH /api/admin/client-management/:clientId/agent { agentId }: kept for compatibility;
// it sets the Client's Agents to exactly this one (agentIds: [agentId]).
export function parseChangeAgentBody(body) {
    if (!isObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const errors = [];
    const agentId = parseAgentId(body, errors);
    return errors.length ? { errors } : { values: { agentId } };
}

// ---------------------------------------------------------------- views

const CLIENT_SELECT = Object.freeze({
    id: true, name: true, isActive: true, contactPerson: true, contactNumber: true, whatsappNumber: true,
    email: true, address: true, createdAt: true, updatedAt: true,
    agentLinks: { select: { agent: { select: { id: true, name: true, countryCode: true, isActive: true } } } },
});

const agentRef = (agent) => ({ agentId: agent.id, name: agent.name, countryCode: agent.countryCode, status: statusOf(agent.isActive) });

const clientView = (row) => {
    // Every linked Agent, by name (then id): no Agent is primary.
    const agents = row.agentLinks.map((link) => link.agent).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map(agentRef);
    return {
        clientId: row.id,
        name: row.name,
        status: statusOf(row.isActive),
        agents,
        // The distinct countries of its Agents (a Client has no country of its own); empty without Agents.
        countryCodes: [...new Set(agents.map((agent) => agent.countryCode))].sort(),
        contactPerson: row.contactPerson ?? null,
        contactNumber: row.contactNumber ?? null,
        whatsappNumber: row.whatsappNumber ?? null,
        email: row.email ?? null,
        address: row.address ?? null,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
    };
};

function listWhere(params) {
    const parts = [];
    if (params.status) parts.push({ isActive: params.status === ENTITY_STATUS.ACTIVE });
    if (params.agentId) parts.push({ agentLinks: { some: { agentId: params.agentId } } });
    if (params.country) parts.push({ agentLinks: { some: { agent: { countryCode: params.country } } } });
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

// GET /api/admin/client-options: every client (all statuses, not paged), for the Agent form's
// client selector (the mirror of /agent-options). The server re-checks every id on save.
export async function listClientOptions({ db }) {
    const rows = await db.client.findMany({ select: { id: true, name: true, isActive: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
    return { clients: rows.map((row) => ({ clientId: row.id, name: row.name, status: statusOf(row.isActive) })) };
}

// GET /api/admin/client-management/:clientId. The jobs are the Client's own (job.client_id):
// one row per job, whatever its Agents.
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

async function lockClient(tx, clientId) {
    const rows = await tx.$queryRaw`SELECT "id" FROM "client" WHERE "id" = ${clientId}::uuid FOR UPDATE`;
    if (!rows.length) throw new CandidateError(404, "CLIENT_NOT_FOUND", "Client not found");
}

const linkedAgentIds = async (tx, clientId) => (await tx.agentClient.findMany({ where: { clientId }, select: { agentId: true }, orderBy: { agentId: "asc" } })).map((row) => row.agentId);

// Sets the Client's Agents to exactly `agentIds` (the caller holds the Client's lock; the
// Agents are share-locked here, after it: client-first order). Every id must exist; a NEW
// link needs an ACTIVE Agent (an Agent already linked may stay while inactive). Adds the new
// links, keeps the unchanged ones, removes the deselected ones. Returns whether anything changed.
async function replaceClientAgents(tx, { actor, clientId, isActive, agentIds, current, audit = true }) {
    const involved = [...new Set([...agentIds, ...current])].sort();
    const rows = await tx.$queryRaw`SELECT "id"::text AS "id", "name", "is_active" AS "isActive" FROM "agent" WHERE "id" = ANY(${involved}::uuid[]) ORDER BY "id" FOR SHARE`;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const missing = agentIds.filter((id) => !byId.has(id));
    if (missing.length) throw new CandidateError(400, "AGENT_NOT_FOUND", `The selected agent does not exist: ${missing.join(", ")}`);
    const added = agentIds.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !agentIds.includes(id));
    if (!added.length && !removed.length) return false;
    const inactive = added.filter((id) => !byId.get(id).isActive);
    if (inactive.length) throw new CandidateError(409, "AGENT_INACTIVE", `An inactive agent cannot be given a client: ${inactive.map((id) => byId.get(id).name).join(", ")}.`);
    if (removed.length) await tx.agentClient.deleteMany({ where: { clientId, agentId: { in: removed } } });
    if (added.length) await tx.agentClient.createMany({ data: added.map((agentId) => ({ agentId, clientId })), skipDuplicates: true });
    if (!audit) return true;
    await tx.auditLog.create({
        data: auditRow({
            actor, action: CLIENT_AUDIT_ACTION.AGENT_CHANGED, previousStatus: statusOf(isActive), newStatus: statusOf(isActive),
            reason: `Client's agents changed: ${added.length} added, ${removed.length} removed`,
            previousValue: JSON.stringify({ clientId, agentIds: current }), newValue: JSON.stringify({ clientId, agentIds, added, removed }),
        }),
    });
    return true;
}

// POST /api/admin/client-management: the Client and its Agent links in one transaction.
export async function createClient({ db, actor, values }) {
    const { agentIds, ...fields } = values;
    try {
        const id = await db.$transaction(async (tx) => {
            const row = await tx.client.create({ data: fields, select: { id: true } });
            await tx.auditLog.create({
                data: auditRow({
                    actor, action: CLIENT_AUDIT_ACTION.CREATED, previousStatus: "NONE", newStatus: ENTITY_STATUS.ACTIVE, reason: "Client created",
                    newValue: JSON.stringify({ clientId: row.id, name: fields.name, agentIds }),
                }),
            });
            // The CLIENT_CREATED entry already records the Agents: no second entry.
            await replaceClientAgents(tx, { actor, clientId: row.id, isActive: true, agentIds, current: [], audit: false });
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

// PATCH /api/admin/client-management/:clientId. Only the given fields change; agentIds (if
// given) replaces the Agents, in the same transaction (any refusal saves nothing). The id
// (and so every job's client_id) never changes, so renaming a Client breaks nothing.
export async function updateClient({ db, actor, clientId, values }) {
    const { agentIds, ...fields } = values;
    try {
        await db.$transaction(async (tx) => {
            await lockClient(tx, clientId);
            const before = await tx.client.findUnique({ where: { id: clientId }, select: CLIENT_SELECT });
            if (agentIds !== undefined) {
                await replaceClientAgents(tx, { actor, clientId, isActive: before.isActive, agentIds, current: await linkedAgentIds(tx, clientId) });
            }
            const { previous, next, changed } = changeSet(before, fields, CLIENT_CHANGE_FIELDS, { redact: CLIENT_REDACTED });
            if (!changed.length) return;
            await tx.client.update({ where: { id: clientId }, data: fields });
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

// PATCH /api/admin/client-management/:clientId/agent { agentId } (compatibility): the Client's
// Agents become exactly [agentId]. Existing jobs keep their own responsible Agent.
export async function changeClientAgent({ db, actor, clientId, agentId }) {
    return updateClient({ db, actor, clientId, values: { agentIds: [agentId] } });
}

// PATCH /api/admin/client-management/:clientId/status. INACTIVE is refused while
// the client has PROCESSING jobs; activating needs at least one ACTIVE linked Agent.
// The row lock serialises this with job creation (jobService.js share-locks the client).
export async function setClientStatus({ db, actor, clientId, status }) {
    await db.$transaction(async (tx) => {
        await lockClient(tx, clientId);
        const before = await tx.client.findUnique({ where: { id: clientId }, select: { isActive: true, agentLinks: { select: { agent: { select: { isActive: true } } } } } });
        const wantActive = status === ENTITY_STATUS.ACTIVE;
        if (before.isActive === wantActive) return;
        if (wantActive && !before.agentLinks.some((link) => link.agent.isActive)) {
            throw new CandidateError(409, "AGENT_INACTIVE", "This client has no active agent. Add an active agent before activating the client.");
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
