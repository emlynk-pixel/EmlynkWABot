import { SubmittedHint, useFieldConflict } from "./submittedChanges";

// The candidate's Candidate Form answers that have no field of their own in Admin (Additional
// details tab), as submitted, each with the usual "Candidate submitted: ... [Confirm] [Revoke]"
// when it differs from the record: a confirmed value becomes the candidate's record (and reaches
// the Google Sheet operational mirror at the next sync). Mother / Father Alive are shown here too,
// but are confirmed from their own fields above. The server derives the height in cm and the
// APPROXIMATE straight-line distance to Bucharest (src/services/candidateFormSubmissionService.js);
// the candidate never sends them, so they are never confirmed. Nothing is shown for a submission
// that has none of these answers.

// confirm: the row offers Confirm / Revoke here (false: elsewhere, or derived).
type Row = { path: string; label: string; confirm?: boolean; show?: (value: string, submitted: Record<string, string | null>) => string };

const yesNo = (value: string) => (value === "YES" ? "Yes" : value === "NO" ? "No" : value);

const ROWS: Row[] = [
    { path: "contact.cityInRomania", label: "City in Romania", confirm: true },
    {
        path: "contact.distanceToBucharestKm",
        label: "Distance to Bucharest",
        show: (value) => `Approx. ${value} km (straight line)`,
    },
    { path: "basic.bloodGroup", label: "Blood Group", confirm: true },
    {
        path: "basic.height",
        label: "Height",
        confirm: true,
        show: (value, submitted) => (submitted["basic.heightCm"] && !/ cm$/.test(value) ? `${value} (≈ ${submitted["basic.heightCm"]} cm)` : value),
    },
    { path: "basic.weight", label: "Weight", confirm: true, show: (value) => `${value} kg` },
    { path: "basic.drivingLicence", label: "Driving Licence", confirm: true, show: yesNo },
    { path: "basic.canReadDrawings", label: "Can Read Drawings", confirm: true, show: yesNo },
    { path: "basic.teamLeadingSkills", label: "Team Leading Skills", confirm: true, show: yesNo },
    { path: "basic.otherLanguages", label: "Other Languages", confirm: true },
    { path: "family.motherAlive", label: "Mother Alive", show: yesNo },
    { path: "family.fatherAlive", label: "Father Alive", show: yesNo },
    { path: "contact.email", label: "Email", confirm: true },
    { path: "contact.city", label: "City", confirm: true },
    { path: "contact.district", label: "District", confirm: true },
    { path: "contact.dsDivision", label: "DS Division", confirm: true },
    { path: "contact.gnDivision", label: "GN Division", confirm: true },
    { path: "qualifications.jobCategoryOther", label: "Other Job Category", confirm: true },
    { path: "qualifications.otherSkills2", label: "Other Skills 2", confirm: true },
    { path: "qualifications.englishKnowledge", label: "English Knowledge", confirm: true },
    { path: "family.father.passportNumber", label: "Father Passport Number", confirm: true },
    { path: "family.mother.passportNumber", label: "Mother Passport Number", confirm: true },
    { path: "family.spouse.passportNumber", label: "Spouse Passport Number", confirm: true },
    { path: "guardian.name", label: "Guardian Name", confirm: true },
    { path: "guardian.relationship", label: "Guardian Relationship", confirm: true },
    { path: "guardian.nic", label: "Guardian NIC", confirm: true },
    { path: "guardian.birthDate", label: "Guardian Birth Date", confirm: true },
    { path: "guardian.phone", label: "Guardian Phone", confirm: true },
    { path: "guardian.address", label: "Guardian Address", confirm: true },
];

export function SubmittedPersonalDetails({ submitted }: { submitted: Record<string, string | null> | null | undefined }) {
    if (!submitted || !ROWS.some((row) => submitted[row.path])) return null;
    const city = submitted["contact.cityInRomania"];
    const display = (row: Row) => {
        const value = submitted[row.path];
        if (row.path === "contact.distanceToBucharestKm" && !value) return city && city !== "N/A" ? "Not available for this city" : "Not applicable";
        if (!value) return "Not recorded";
        return value === "N/A" || !row.show ? value : row.show(value, submitted);
    };
    return (
        <section aria-labelledby="submitted-personal-title" data-testid="submitted-personal-details" className="mt-6 rounded border border-border p-4">
            <h3 id="submitted-personal-title" className="text-label-md font-semibold text-ink">Submitted on the Candidate Form</h3>
            <p className="mt-1 text-label-sm text-ink-muted">Answers with no field of their own above, as the candidate submitted them. A confirmed value becomes part of the candidate&apos;s record. The distance is approximate (straight line, not by road).</p>
            <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                {ROWS.map((row) => <SubmittedRow key={row.path} row={row} value={display(row)} />)}
            </dl>
        </section>
    );
}

function SubmittedRow({ row, value }: { row: Row; value: string }) {
    const conflict = useFieldConflict(row.confirm ? row.path : undefined);
    const highlight = conflict.focused
        ? "rounded-md bg-critical-bg p-2 -m-2 ring-2 ring-critical"
        : conflict.pending ? "rounded-md bg-review-bg p-2 -m-2 ring-1 ring-review-border" : "";
    return (
        <div className={`min-w-0 ${highlight}`.trim()} data-conflict-field={row.confirm ? row.path : undefined}>
            <dt className="text-label-sm text-ink-muted">{row.label}</dt>
            <dd className="break-words text-body-sm text-ink">{value}</dd>
            {row.confirm && <SubmittedHint field={row.path} />}
        </div>
    );
}
