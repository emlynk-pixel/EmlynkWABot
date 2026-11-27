// "Allocated To" on the candidate page: who the candidate is allocated to, as far as the viewer's role
// may see. The rule is applied on the server, before the response is built, so a user whose role may
// not see an allocated user never receives that user's data (the page never filters it itself).
//
//   OWNER, ADMIN   every allocated user
//   TEAM_LEAD      allocated users who are an Analyst or a Team Lead
//   ANALYST        allocated users who are an Analyst (never a Team Lead, Admin or Owner)
//   anyone else    nothing: the field is left out of the response
//
// Which candidates a role may open is not decided here (candidateAccess.js).

import { ROLES } from "../middleware/requireRole.js";

const VISIBLE_ALLOCATED_ROLES = Object.freeze({
    [ROLES.OWNER]: null, // null = every role
    [ROLES.ADMIN]: null,
    [ROLES.TEAM_LEAD]: Object.freeze([ROLES.ANALYST, ROLES.TEAM_LEAD]),
    [ROLES.ANALYST]: Object.freeze([ROLES.ANALYST]),
});

// Does this viewer role get the "Allocated To" detail at all?
export const canSeeAllocatedTo = (viewerRole) => Object.hasOwn(VISIBLE_ALLOCATED_ROLES, viewerRole);

// allocated: [{ adminId, name, role }]. Returns the ones the viewer may see, or undefined when the viewer's
// role gets no "Allocated To" at all.
export function visibleAllocatedTo(viewerRole, allocated) {
    if (!canSeeAllocatedTo(viewerRole)) return undefined;
    const roles = VISIBLE_ALLOCATED_ROLES[viewerRole];
    return allocated.filter((user) => roles === null || roles.includes(user.role));
}

// The candidate's details with `allocatedTo` added for this viewer (a candidate has at most one allocation).
export async function withAllocatedTo({ db, viewerRole, passportId, details }) {
    if (!details || !canSeeAllocatedTo(viewerRole)) return details;
    const row = await db.candidateAllocation.findUnique({
        where: { passportId },
        select: { analyst: { select: { adminId: true, name: true, role: true } } },
    });
    const allocated = row?.analyst ? [{ adminId: row.analyst.adminId, name: row.analyst.name, role: row.analyst.role }] : [];
    return { ...details, allocatedTo: visibleAllocatedTo(viewerRole, allocated) };
}
