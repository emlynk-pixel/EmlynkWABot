import { ROLES } from "../middleware/requireRole.js";

// Which candidates a signed-in user may see and change (Work Allocation).
// The one place the rule lives; every candidate route and every list that
// names candidates goes through it, on every request (the user's role is
// read from the database by requireActiveUser, and the allocation here), so
// a reassignment or role change applies to the very next request.
//
//   ADMIN, MANAGER, REGISTRATION_DESK   every candidate
//   ANALYST                             only the candidates allocated to them
//                                       (candidate_allocation.analyst_id)
//   anything else                       none (fails closed)

const UNRESTRICTED_ROLES = Object.freeze([ROLES.ADMIN, ROLES.MANAGER, ROLES.REGISTRATION_DESK]);

// Matches no candidate: a passport ID is never empty.
const NO_CANDIDATE = Object.freeze({ passportId: { in: [] } });

export const isCandidateScoped = (user) => !UNRESTRICTED_ROLES.includes(user?.role);

// A Prisma `where` for public.candidate: {} for unrestricted roles, the
// Analyst's own allocations otherwise. Combine with other conditions under
// AND, never by spreading, so it can't be overridden.
export function candidateScope(user) {
    if (!isCandidateScoped(user)) return {};
    if (user?.role === ROLES.ANALYST && user.adminId) return { allocation: { is: { analystId: user.adminId } } };
    return NO_CANDIDATE;
}

// `where` AND the user's scope (or `where` alone when unrestricted).
export function scopedWhere(user, where = {}) {
    if (!isCandidateScoped(user)) return where;
    return Object.keys(where).length ? { AND: [where, candidateScope(user)] } : candidateScope(user);
}

// ---- the same scope for the other tables (Overview, Review Queue, reports).
// Each takes the `scope` from candidateScope(user) ({} = unrestricted) and
// returns a Prisma `where` fragment ({} when unrestricted, so an unrestricted
// user's queries are exactly what they were).

const isUnrestricted = (scope) => !scope || Object.keys(scope).length === 0;

// Rows that belong to one candidate (documents, call logs, stages): only the
// user's candidates.
export const linkedScope = (scope) => (isUnrestricted(scope) ? {} : { user: scope });

// Submissions (temporary_data): the user's candidates' and the ones not yet
// linked to any candidate (waiting files nobody owns yet, which is the review
// work). Once a file is linked, it follows the candidate's allocation.
export const submissionScope = (scope) => (isUnrestricted(scope) ? {} : { OR: [{ passportId: null }, { user: scope }] });

// Audit entries name a candidate by passport ID only (no relation): the
// entries about the user's candidates. One indexed query for the IDs.
export async function auditScope(db, scope) {
    if (isUnrestricted(scope)) return {};
    const rows = await db.candidate.findMany({ where: scope, select: { passportId: true } });
    return { passportId: { in: rows.map((row) => row.passportId) } };
}

// Conditions AND-ed; empty ones dropped, and a single one returned as it is.
export function andWhere(...parts) {
    const used = parts.filter((part) => part && Object.keys(part).length);
    if (used.length === 0) return {};
    return used.length === 1 ? used[0] : { AND: used };
}

// `{ where }` for a query that had no filter before, or nothing when the
// fragment is empty (the unrestricted call is unchanged).
export const whereOnly = (fragment) => (isUnrestricted(fragment) ? {} : { where: fragment });

// The passport IDs a scoped user may see, or null for "every candidate".
// For lists computed in memory (the Police Workflow). An Analyst's set is
// their allocations: one indexed query.
export async function accessiblePassportIds(db, user) {
    if (!isCandidateScoped(user)) return null;
    const rows = await db.candidate.findMany({ where: candidateScope(user), select: { passportId: true } });
    return new Set(rows.map((row) => row.passportId));
}

// True when the user may open the stored candidate `passportId`.
export async function canAccessCandidate(db, user, passportId) {
    if (!isCandidateScoped(user)) return true;
    const row = await db.candidate.findFirst({ where: { AND: [{ passportId }, candidateScope(user)] }, select: { passportId: true } });
    return Boolean(row);
}

// Work Allocation itself (the page and its API): ADMIN and MANAGER only.
export const ALLOCATION_MANAGER_ROLES = Object.freeze([ROLES.ADMIN, ROLES.MANAGER]);
