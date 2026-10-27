import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { CONFIRMABLE_LABELS } from "./submittedChanges";

// Candidate Form conflicts: candidate-submitted values that differ from the candidate's record and
// still wait for a Confirm / Revoke (the server's pendingChanges, candidateFormFieldConfirmService.js).
// The Candidates list shows a small red "!" per candidate that has any; it opens the candidate page
// at the first one, where every unresolved field is highlighted (Field in CandidateFields.tsx) and
// the one asked for is scrolled to and focused. Nothing is stored: when the last field is
// confirmed or revoked, the server stops listing it and the indicator and highlights go away.

// Fields whose home is Additional details (candidate_additional_details); the rest are on the
// Candidate details stage.
const ADDITIONAL_DETAILS_FIELDS = new Set([
    "basic.fullName", "measurements.shirtSize", "measurements.waistSize", "measurements.shoeSize", "family.father.birthDate", "family.mother.birthDate",
    "family.fatherAlive", "family.motherAlive",
    "basic.civilStatus", "family.father.fullName", "family.mother.fullName", "family.spouse.fullName", "family.spouse.birthDate",
    "family.child1", "family.child2", "family.child3", "qualifications.otherSkills1",
    // Confirmed from the "Submitted on the Candidate Form" card (Additional details tab).
    "basic.bloodGroup", "basic.height", "basic.weight", "basic.drivingLicence", "basic.canReadDrawings", "basic.teamLeadingSkills", "basic.otherLanguages",
    "contact.email", "contact.city", "contact.district", "contact.dsDivision", "contact.gnDivision", "contact.cityInRomania",
    "qualifications.jobCategoryOther", "qualifications.otherSkills2", "qualifications.englishKnowledge",
    "family.father.passportNumber", "family.mother.passportNumber", "family.spouse.passportNumber",
    "guardian.name", "guardian.relationship", "guardian.nic", "guardian.birthDate", "guardian.phone", "guardian.address",
]);

export const CONFLICT_FIELD_PARAM = "field";

// The candidate page, opened where a conflicting field lives, with that field asked for.
export function conflictHref(passportId: string, field: string): string {
    const params = new URLSearchParams(ADDITIONAL_DETAILS_FIELDS.has(field) ? { tab: "additional" } : { stage: "CANDIDATE_DETAILS" });
    params.set(CONFLICT_FIELD_PARAM, field);
    return `/candidates/${encodeURIComponent(passportId)}?${params.toString()}`;
}

const labelOf = (field: string) => CONFIRMABLE_LABELS[field]?.label ?? field;

export function conflictSummary(fields: readonly string[]): string {
    const names = fields.map(labelOf);
    return fields.length === 1
        ? `Candidate Form change to review: ${names[0]}`
        : `${fields.length} Candidate Form changes to review: ${names.join(", ")}`;
}

// The red circular "!". Nothing when there is no unresolved conflict.
export function ConflictIndicator({ passportId, fields }: { passportId: string; fields?: readonly string[] | null }) {
    if (!fields?.length) return null;
    const summary = conflictSummary(fields);
    return (
        <Link
            to={conflictHref(passportId, fields[0])}
            onClick={(event) => event.stopPropagation()}
            title={summary}
            aria-label={summary}
            data-testid={`form-conflict-${passportId}`}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-critical text-[10px] font-bold leading-none text-on-critical hover:bg-critical-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-critical"
        >
            <span aria-hidden="true">!</span>
        </Link>
    );
}

// On the candidate page: once the field asked for in the URL is on screen, scroll to it and focus
// its input (once per field asked for). `ready`: the section that holds it has rendered.
export function useConflictFocus(field: string | null, ready: boolean) {
    const done = useRef<string | null>(null);
    useEffect(() => {
        if (!field || !ready || done.current === field) return undefined;
        let tries = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const attempt = () => {
            const container = [...document.querySelectorAll<HTMLElement>("[data-conflict-field]")].find((element) => element.dataset.conflictField === field);
            if (container) {
                done.current = field;
                container.scrollIntoView?.({ block: "center", behavior: "smooth" });
                container.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
                return;
            }
            // The section loads its data separately (Additional details): look again shortly.
            if (tries++ < 20) timer = setTimeout(attempt, 100);
        };
        attempt();
        return () => clearTimeout(timer);
    }, [field, ready]);
}
