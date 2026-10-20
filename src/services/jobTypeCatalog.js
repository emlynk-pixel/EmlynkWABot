// Job Types as a managed list (job_type, Settings > Job Types) and the special
// candidate preference "No Preferred Type". One place for:
//   - the ACTIVE job type names offered for NEW selections (admin candidate
//     pickers, the Candidate Form, new Jobs);
//   - "No Preferred Type": a SYSTEM option, NOT a job_type row. It is stored on
//     the candidate as the stable code NO_PREFERENCE (shown as its label), so a
//     Job (job.job_type_id -> job_type) can never have it, and nobody can rename,
//     delete or deactivate it;
//   - resolving a candidate's requested preferences against that list.
//
// Candidates keep storing their preferences as text (candidate.job, comma
// separated): values saved before this list existed stay on the candidate and
// keep displaying (they are not copied into the list), and a type that is later
// deactivated stays on the candidates who have it. Only NEW selections must come
// from the active list. Job assignment does not compare types (business decision):
// "No Preferred Type" is a recorded preference, not an assignment rule.

export const NO_PREFERRED_JOB_TYPE = Object.freeze({ code: "NO_PREFERENCE", label: "No Preferred Type" });

// The code, or the label typed in any case: both mean "No Preferred Type".
export const isNoPreference = (value) => typeof value === "string"
    && [NO_PREFERRED_JOB_TYPE.code, NO_PREFERRED_JOB_TYPE.label.toUpperCase()].includes(value.trim().toUpperCase());

// What a stored candidate preference is called on screen (and in the Google Sheet).
export const jobTypeLabel = (value) => (isNoPreference(value) ? NO_PREFERRED_JOB_TYPE.label : value);
export const jobTypesLabel = (job) => (typeof job === "string" ? job.split(",").map((part) => jobTypeLabel(part.trim())).filter(Boolean).join(", ") : job);

// The active job type names, A to Z (the names as the administrators wrote them).
export async function activeJobTypeNames(db) {
    const rows = await db.jobType.findMany({ where: { isActive: true }, select: { name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
    return rows.map((row) => row.name);
}

// A candidate's requested preferences (already shape-checked by parseCandidateBody)
// against the active list. Each value must be:
//   - "No Preferred Type" (then it must be the ONLY one: it means "any type"), or
//   - an active job type (matched case-insensitively, stored with the list's spelling), or
//   - a value the candidate ALREADY has (`current`): historical free text or a type
//     deactivated since; kept as it was, never rewritten.
// Returns { jobTypes } (the values to store) or { errors }.
export async function resolveCandidateJobTypes({ db, requested, current = [] }) {
    if (requested.some(isNoPreference)) {
        if (requested.length > 1) return { errors: [{ field: "jobTypes", message: `"${NO_PREFERRED_JOB_TYPE.label}" cannot be combined with other job types` }] };
        return { jobTypes: [NO_PREFERRED_JOB_TYPE.code] };
    }
    const active = new Map((await activeJobTypeNames(db)).map((name) => [name.toLowerCase(), name]));
    const kept = new Map(current.filter((value) => !isNoPreference(value)).map((value) => [value.toLowerCase(), value]));
    const jobTypes = [];
    for (const value of requested) {
        const key = value.trim().toLowerCase();
        const resolved = active.get(key) ?? kept.get(key);
        if (!resolved) return { errors: [{ field: "jobTypes", message: `"${value.trim()}" is not an active job type (Settings > Job Types)` }] };
        if (!jobTypes.some((existing) => existing.toLowerCase() === resolved.toLowerCase())) jobTypes.push(resolved);
    }
    return { jobTypes };
}
