// The Personal Details and parents' alive answers of the candidate's Candidate Form submission,
// READ ONLY (Additional details tab). City in Romania, Blood Group, Other Languages, Driving
// Licence, Can Read Drawings, Team Leading Skills, Height and Weight have no column in the
// candidate's record, so they are shown as submitted; Mother / Father Alive can also be confirmed
// into Additional details from their own fields above ("Candidate submitted: ... [Confirm]").
// The server derives the height in cm and the APPROXIMATE straight-line distance to Bucharest
// (src/services/candidateFormSubmissionService.js); the candidate never sends them.
// Nothing is shown for a submission from before these questions existed.

type Row = { path: string; label: string; show?: (value: string, submitted: Record<string, string | null>) => string };

const yesNo = (value: string) => (value === "YES" ? "Yes" : value === "NO" ? "No" : value);

const ROWS: Row[] = [
    { path: "contact.cityInRomania", label: "City in Romania" },
    {
        path: "contact.distanceToBucharestKm",
        label: "Distance to Bucharest",
        show: (value) => `Approx. ${value} km (straight line)`,
    },
    { path: "basic.bloodGroup", label: "Blood Group" },
    {
        path: "basic.height",
        label: "Height",
        show: (value, submitted) => (submitted["basic.heightCm"] && !/ cm$/.test(value) ? `${value} (≈ ${submitted["basic.heightCm"]} cm)` : value),
    },
    { path: "basic.weight", label: "Weight", show: (value) => `${value} kg` },
    { path: "basic.drivingLicence", label: "Driving Licence", show: yesNo },
    { path: "basic.canReadDrawings", label: "Can Read Drawings", show: yesNo },
    { path: "basic.teamLeadingSkills", label: "Team Leading Skills", show: yesNo },
    { path: "basic.otherLanguages", label: "Other Languages" },
    { path: "family.motherAlive", label: "Mother Alive", show: yesNo },
    { path: "family.fatherAlive", label: "Father Alive", show: yesNo },
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
            <p className="mt-1 text-label-sm text-ink-muted">Personal details and parents&apos; status as the candidate submitted them. The distance is approximate (straight line, not by road).</p>
            <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                {ROWS.map((row) => (
                    <div key={row.path} className="min-w-0">
                        <dt className="text-label-sm text-ink-muted">{row.label}</dt>
                        <dd className="break-words text-body-sm text-ink">{display(row)}</dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}
