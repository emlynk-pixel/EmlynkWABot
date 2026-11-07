import { ROLES, hasRole } from "../middleware/requireRole.js";
import { USER_STATUS } from "../middleware/requireActiveUser.js";
import { businessDayRange, isValidBusinessDate } from "../utils/businessDay.js";
import { searchTokens } from "../utils/searchText.js";
import { andWhere } from "./candidateAccess.js";
import { WORKFLOW_STATUS } from "./candidateWorkflowStatus.js";
import { activeJobTypeNames, NO_PREFERRED_JOB_TYPE } from "./jobTypeCatalog.js";

// Advanced candidate filters: ONE definition for every candidate list (Admin > Candidates,
// Work Allocation's Unallocated and Allocated views). Only business filters live here; the
// caller AND-s them with the user's candidate scope (candidateAccess.js) and its own base
// condition (the Work Allocation view), never by spreading, so a filter can only narrow a list.
//
// Query parameters (all optional, every one AND-ed with the others):
//   text            name, surname, otherNames, passport, nic, whatsapp, nationality, jobCode
//                   <field>Match: contains (default) | startsWith | equals, any letter case.
//                   name (surname + other names) is contains only: every word must be in one of them.
//   lists           comma-separated, any of the values (IN):
//                   jobType         one of the candidate's job types, exact name (any case)
//                   workflowStatus  the Candidates list's Status (candidateWorkflowStatus.js)
//                   stage           the current stage (the first not completed), or COMPLETE
//                   sex             M | F | X
//                   analystId       the Officer the candidate is allocated to
//                   clientId / agentId   the Client / responsible Agent of a current (active) job
//   allocation      ALLOCATED | UNALLOCATED
//   dates           registeredFrom / registeredTo (candidate.created_date) and testFrom / testTo
//                   (the Test details date): YYYY-MM-DD, inclusive Sri Lanka calendar days.
// A parameter not listed here is ignored (the list endpoints' convention); a listed one with a
// bad value is refused with 400 before anything is read. Field names never reach Prisma: every
// condition below is written out against a fixed column.

// Same list as candidateService.CANDIDATE_STAGES (not imported: candidateService imports this module).
export const CANDIDATE_STAGE_KEYS = Object.freeze([
    "TEST_DETAILS", "JOB_DETAILS", "CANDIDATE_DETAILS", "DOCUMENT_SUBMISSION", "VISA_SUBMISSION", "VISA_APPROVAL",
]);
export const STAGE_FILTERS = Object.freeze([...CANDIDATE_STAGE_KEYS, "COMPLETE"]);
export const TEXT_MATCHES = Object.freeze(["contains", "startsWith", "equals"]);
const SEX_FILTERS = Object.freeze(["M", "F", "X"]);
const ALLOCATION_FILTERS = Object.freeze(["ALLOCATED", "UNALLOCATED"]);

const MAX_TEXT_LENGTH = 100;
const MAX_JOB_TYPE_LENGTH = 120;
const MAX_LIST_VALUES = 50;
const MAX_NAME_WORDS = 5;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// field -> the operators it takes.
const TEXT_FILTERS = Object.freeze({
    name: ["contains"],
    surname: TEXT_MATCHES,
    otherNames: TEXT_MATCHES,
    passport: TEXT_MATCHES,
    nic: TEXT_MATCHES,
    whatsapp: TEXT_MATCHES,
    nationality: TEXT_MATCHES,
    jobCode: TEXT_MATCHES,
});

// field -> how one value is checked (and normalised).
const LIST_FILTERS = Object.freeze({
    jobType: { check: (value) => value.length <= MAX_JOB_TYPE_LENGTH, message: `must be job type names of at most ${MAX_JOB_TYPE_LENGTH} characters` },
    workflowStatus: { check: (value) => Object.values(WORKFLOW_STATUS).includes(value), message: `must be one or more of: ${Object.values(WORKFLOW_STATUS).join(", ")}` },
    stage: { check: (value) => STAGE_FILTERS.includes(value), message: `must be one or more of: ${STAGE_FILTERS.join(", ")}` },
    sex: { check: (value) => SEX_FILTERS.includes(value), message: `must be one or more of: ${SEX_FILTERS.join(", ")}` },
    analystId: { check: (value) => ID_PATTERN.test(value), message: "must be user IDs" },
    clientId: { check: (value) => UUID_PATTERN.test(value), message: "must be client IDs" },
    agentId: { check: (value) => UUID_PATTERN.test(value), message: "must be agent IDs" },
});

const DATE_RANGES = Object.freeze([["registeredFrom", "registeredTo"], ["testFrom", "testTo"]]);

// Filters that need what only some roles may see: the Officer a candidate is allocated to
// (Work Allocation's roles), and the job's Client and Agent (the roles that read Jobs).
const ALLOCATION_FIELDS = Object.freeze(["analystId", "allocation"]);
const JOB_RELATION_FIELDS = Object.freeze(["clientId", "agentId"]);
const ALLOCATION_READERS = Object.freeze([ROLES.ADMIN, ROLES.TEAM_LEAD]);
const JOB_RELATION_READERS = Object.freeze([ROLES.ADMIN, ROLES.TEAM_LEAD, ROLES.JOB_HANDLER]);

// The filters a user's role may use (GET /candidate-filter-options returns the matching choices).
export function filterAccess(user) {
    return { allocation: hasRole(user?.role, ALLOCATION_READERS), jobRelations: hasRole(user?.role, JOB_RELATION_READERS) };
}

// One query value: undefined when absent or empty; a repeated parameter is an error.
export function queryValue(query, field, errors) {
    const value = query[field];
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string") {
        errors.push({ field, message: "must be given once" });
        return undefined;
    }
    return value;
}

// filters: the parsed values, kept as normalised query strings (a list is "A,B"), so they are
// echoed back exactly as the page can send them again. `exclude`: fields this endpoint does not
// take (ignored, like any other unknown parameter). `access`: filterAccess(user); a filter the
// role may not use is refused.
export function parseCandidateFilters(query = {}, { exclude = [], access = { allocation: true, jobRelations: true } } = {}) {
    const errors = [];
    const filters = {};
    const takes = (field) => !exclude.includes(field);
    const allowed = (field) => {
        if (ALLOCATION_FIELDS.includes(field) && !access.allocation) return false;
        if (JOB_RELATION_FIELDS.includes(field) && !access.jobRelations) return false;
        return true;
    };
    const read = (field) => {
        if (!takes(field)) return undefined;
        const value = queryValue(query, field, errors);
        if (value !== undefined && !allowed(field)) {
            errors.push({ field, message: "is not available for your role" });
            return undefined;
        }
        return value;
    };

    for (const [field, matches] of Object.entries(TEXT_FILTERS)) {
        const value = read(field);
        const match = takes(field) ? queryValue(query, `${field}Match`, errors) : undefined;
        if (match !== undefined && !matches.includes(match)) {
            errors.push({ field: `${field}Match`, message: `must be one of: ${matches.join(", ")}` });
        }
        if (value === undefined) continue;
        // Spaces collapsed (utils/searchText.js); the typed letter case is kept for the echo, matching ignores it.
        const trimmed = value.trim().replace(/\s+/g, " ");
        if (trimmed.length > MAX_TEXT_LENGTH) errors.push({ field, message: `must be at most ${MAX_TEXT_LENGTH} characters` });
        else if (trimmed) {
            filters[field] = trimmed;
            if (match && match !== "contains" && matches.includes(match)) filters[`${field}Match`] = match;
        }
    }

    for (const [field, rule] of Object.entries(LIST_FILTERS)) {
        const value = read(field);
        if (value === undefined) continue;
        const values = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
        if (values.length > MAX_LIST_VALUES) errors.push({ field, message: `must name at most ${MAX_LIST_VALUES} values` });
        else if (!values.every(rule.check)) errors.push({ field, message: rule.message });
        else if (values.length) filters[field] = values.join(",");
    }

    const allocation = read("allocation");
    if (allocation !== undefined) {
        if (ALLOCATION_FILTERS.includes(allocation)) filters.allocation = allocation;
        else errors.push({ field: "allocation", message: `must be one of: ${ALLOCATION_FILTERS.join(", ")}` });
    }

    for (const [from, to] of DATE_RANGES) {
        for (const field of [from, to]) {
            const value = read(field);
            if (value === undefined) continue;
            if (isValidBusinessDate(value)) filters[field] = value;
            else errors.push({ field, message: "must be a date as YYYY-MM-DD" });
        }
        if (filters[from] && filters[to] && filters[from] > filters[to]) errors.push({ field: to, message: `must not be before ${from}` });
    }
    return { filters, errors };
}

export const listValues = (value) => (value ? value.split(",") : []);

const insensitive = (match, value) => ({ [match]: value, mode: "insensitive" });

// The WhatsApp number as typed, in the forms it may be stored in: "+94771234567" (every new
// write), "94771234567" or "0771234567" (older rows). A value that is not a phone number is
// matched as it is.
function phoneVariants(value) {
    const digits = value.replace(/\D/g, "");
    if (!digits || !/^\+?[\d\s-]+$/.test(value)) return [value];
    const variants = new Set([digits]);
    if (digits.startsWith("0")) variants.add(`94${digits.slice(1)}`);
    if (digits.startsWith("94")) variants.add(`0${digits.slice(2)}`);
    return [...variants];
}

function whatsappWhere(value, match) {
    const variants = phoneVariants(value);
    // A stored number may start with "+": a prefix or exact match tries it with and without.
    const forms = match === "contains" ? variants : variants.flatMap((variant) => (/^\d/.test(variant) ? [variant, `+${variant}`] : [variant]));
    const conditions = forms.map((form) => ({ whatsappNumber: insensitive(match, form) }));
    return conditions.length === 1 ? conditions[0] : { OR: conditions };
}

// The UTC instants of an inclusive range of Sri Lanka calendar days: from the start of `from`
// up to (not including) the start of the day after `to`, so the whole last day is in.
function businessDaysWhere(from, to) {
    return {
        ...(from ? { gte: businessDayRange(from).start } : {}),
        ...(to ? { lt: businessDayRange(to).end } : {}),
    };
}

// A DATE column (no time, no zone): the calendar days themselves, inclusive.
const calendarDaysWhere = (from, to) => ({
    ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
    ...(to ? { lte: new Date(`${to}T00:00:00.000Z`) } : {}),
});

// The database part of the filters: a Prisma `where` on public.candidate ({} = none). The exact
// job type, the Status and the current stage are derived values: this narrows them with a
// database pre-filter and derivedFilterMatch applies them exactly.
export function candidateFilterWhere(filters = {}) {
    const parts = [];
    const text = (field, column) => {
        if (filters[field]) parts.push({ [column]: insensitive(filters[`${field}Match`] ?? "contains", filters[field]) });
    };
    if (filters.name) {
        const words = searchTokens(filters.name, MAX_NAME_WORDS);
        // first_name holds the other (given) names, other_name the surname (clientName.js).
        parts.push(...words.map((word) => ({ OR: [{ firstName: insensitive("contains", word) }, { otherName: insensitive("contains", word) }] })));
    }
    text("surname", "otherName");
    text("otherNames", "firstName");
    text("passport", "passportId");
    text("nic", "nic");
    text("nationality", "nationality");
    if (filters.whatsapp) parts.push(whatsappWhere(filters.whatsapp, filters.whatsappMatch ?? "contains"));
    if (filters.sex) parts.push({ sex: { in: listValues(filters.sex) } });
    if (filters.jobType) {
        const types = listValues(filters.jobType);
        parts.push(types.length === 1 ? { job: insensitive("contains", types[0]) } : { OR: types.map((type) => ({ job: insensitive("contains", type) })) });
    }
    if (filters.registeredFrom || filters.registeredTo) parts.push({ createdDate: businessDaysWhere(filters.registeredFrom, filters.registeredTo) });
    if (filters.testFrom || filters.testTo) {
        parts.push({ stages: { some: { stage: "TEST_DETAILS", testDate: calendarDaysWhere(filters.testFrom, filters.testTo) } } });
    }
    if (filters.allocation === "UNALLOCATED") parts.push({ allocation: { is: null } });
    if (filters.allocation === "ALLOCATED") parts.push({ allocation: { isNot: null } });
    if (filters.analystId) parts.push({ allocation: { is: { analystId: { in: listValues(filters.analystId) } } } });
    // The current job: an active assignment (job_candidate.is_active), as the Status reads it.
    const job = {};
    if (filters.jobCode) job.jobCode = insensitive(filters.jobCodeMatch ?? "contains", filters.jobCode);
    if (filters.clientId) job.clientId = { in: listValues(filters.clientId) };
    if (filters.agentId) job.responsibleAgentId = { in: listValues(filters.agentId) };
    if (Object.keys(job).length) parts.push({ jobAssignments: { some: { isActive: true, job } } });
    return andWhere(...parts);
}

export const needsDerivedFilter = (filters = {}) => Boolean(filters.jobType || filters.workflowStatus || filters.stage);

// Whether a row matches the derived filters. jobTypes: the row's parsed job types; status: its
// workflow Status code; currentStage: the first stage not completed (null = all completed).
export function derivedFilterMatch({ jobTypes, status, currentStage }, filters = {}) {
    if (filters.jobType) {
        const wanted = new Set(listValues(filters.jobType).map((type) => type.toLowerCase()));
        if (!jobTypes.some((type) => wanted.has(type.toLowerCase()))) return false;
    }
    if (filters.workflowStatus && !listValues(filters.workflowStatus).includes(status)) return false;
    if (filters.stage) {
        const stage = currentStage ?? "COMPLETE";
        if (!listValues(filters.stage).includes(stage)) return false;
    }
    return true;
}

// GET /api/admin/candidate-filter-options: the choices of the dropdown filters, from the system's
// own data, and only those the user's role may use (filterAccess). The Status and stage choices
// are fixed lists the page holds. Officers: active Analysts and anyone still holding candidates
// (the bulk import's officers, deactivated Analysts), so those candidates can be found. Clients
// and Agents: those named on a job. Three small queries at most, never per candidate.
export async function listCandidateFilterOptions({ db, user }) {
    const access = filterAccess(user);
    const byName = [{ name: "asc" }, { id: "asc" }];
    const [jobTypes, officers, clients, agents] = await Promise.all([
        activeJobTypeNames(db),
        access.allocation
            ? db.user.findMany({
                where: { OR: [{ role: ROLES.ANALYST, status: USER_STATUS.ACTIVE }, { allocatedCandidates: { some: {} } }] },
                select: { adminId: true, name: true, role: true, status: true },
                orderBy: [{ name: "asc" }, { adminId: "asc" }],
            })
            : null,
        access.jobRelations ? db.client.findMany({ where: { jobs: { some: {} } }, select: { id: true, name: true }, orderBy: byName }) : null,
        access.jobRelations ? db.agent.findMany({ where: { jobs: { some: {} } }, select: { id: true, name: true }, orderBy: byName }) : null,
    ]);
    return {
        jobTypes,
        noPreference: NO_PREFERRED_JOB_TYPE,
        ...(officers ? { officers: officers.map((officer) => ({ id: officer.adminId, name: officer.name, active: officer.status === USER_STATUS.ACTIVE && officer.role === ROLES.ANALYST })) } : {}),
        ...(clients ? { clients } : {}),
        ...(agents ? { agents } : {}),
    };
}
