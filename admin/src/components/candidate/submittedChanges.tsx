import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../../api/client";
import { confirmAllFormFields, confirmFormField, rejectAllFormFields, rejectFormField, type PendingChange, englishLevelLabel } from "../../api/candidates";
import { ActionDialog, DialogError, dangerSolidButton, primaryButton, secondaryButton } from "../Dialog";
import { formatDay, humanize } from "../format";

// Per-field "Candidate submitted: <value> [Confirm]" under the fields of the
// candidate's record. The record's own value stays the main value; a hint is
// shown only when the candidate submitted a DIFFERENT value for a field that has a
// real home in the record (the server decides which: candidateFormFieldConfirmService.js).
// Confirm applies that ONE field after a confirmation; Revoke dismisses the proposal and leaves the record as it
// is (it is not an undo of a Confirm). Both are final for that field and share one review state on the server.
// Roles that cannot confirm still see the hint, without the button.
// FormChangesButtons offers Confirm All / Reject All (one server transaction each) in the forms' footers;
// they are shown only to the roles that can confirm, while something is pending.

type Kind = "text" | "date" | "code";
export const CONFIRMABLE_LABELS: Record<string, { label: string; kind: Kind }> = {
    "basic.surname": { label: "Surname", kind: "text" },
    "basic.otherNames": { label: "Other names", kind: "text" },
    "basic.sex": { label: "Sex", kind: "code" },
    "basic.birthDate": { label: "Date of birth", kind: "date" },
    "basic.birthPlace": { label: "Place of birth", kind: "text" },
    "contact.address": { label: "Address", kind: "text" },
    "contact.alternativePhone": { label: "Contact number", kind: "text" },
    "passport.issueDate": { label: "Passport issue date", kind: "date" },
    "passport.expiryDate": { label: "Passport expiry date", kind: "date" },
    "qualifications.experience": { label: "Job experience", kind: "text" },
    "basic.fullName": { label: "Name according to passport", kind: "text" },
    "measurements.shirtSize": { label: "T-shirt size", kind: "text" },
    "measurements.waistSize": { label: "Pant size", kind: "text" },
    "measurements.shoeSize": { label: "Shoe size (EU)", kind: "text" },
    "family.father.birthDate": { label: "Father birthday", kind: "date" },
    "family.mother.birthDate": { label: "Mother birthday", kind: "date" },
    "family.fatherAlive": { label: "Father alive", kind: "code" },
    "family.motherAlive": { label: "Mother alive", kind: "code" },
    "qualifications.jobCategory": { label: "Job type", kind: "text" },
    "basic.civilStatus": { label: "Marital status", kind: "code" },
    "family.father.fullName": { label: "Father full name", kind: "text" },
    "family.mother.fullName": { label: "Mother full name", kind: "text" },
    "family.spouse.fullName": { label: "Wife full name", kind: "text" },
    "family.spouse.birthDate": { label: "Wife birthday", kind: "date" },
    "family.child1": { label: "1st child name", kind: "text" },
    "family.child2": { label: "2nd child name", kind: "text" },
    "family.child3": { label: "3rd child name", kind: "text" },
    "qualifications.otherSkills1": { label: "Other job skills", kind: "text" },
    // The Candidate Form's other answers (their own fields on the Additional details tab).
    "basic.bloodGroup": { label: "Blood Group", kind: "text" },
    "basic.height": { label: "Height", kind: "text" },
    "basic.weight": { label: "Weight (kg)", kind: "text" },
    "basic.drivingLicence": { label: "Driving Licence", kind: "code" },
    "basic.canReadDrawings": { label: "Can Read Drawings", kind: "code" },
    "basic.teamLeadingSkills": { label: "Team Leading Skills", kind: "code" },
    "basic.otherLanguages": { label: "Other Languages", kind: "text" },
    "contact.email": { label: "Email", kind: "text" },
    "contact.city": { label: "City", kind: "text" },
    "contact.district": { label: "District", kind: "text" },
    "contact.dsDivision": { label: "DS Division", kind: "text" },
    "contact.gnDivision": { label: "GN Division", kind: "text" },
    "contact.cityInRomania": { label: "City in Romania", kind: "text" },
    "qualifications.jobCategoryOther": { label: "Other Job Category", kind: "text" },
    "qualifications.otherSkills2": { label: "Other Skills 2", kind: "text" },
    "qualifications.englishKnowledge": { label: "English Knowledge", kind: "code" },
    "family.father.passportNumber": { label: "Father Passport Number", kind: "text" },
    "family.mother.passportNumber": { label: "Mother Passport Number", kind: "text" },
    "family.spouse.passportNumber": { label: "Spouse Passport Number", kind: "text" },
    "guardian.name": { label: "Guardian Name", kind: "text" },
    "guardian.relationship": { label: "Guardian Relationship", kind: "text" },
    "guardian.nic": { label: "Guardian NIC", kind: "text" },
    "guardian.birthDate": { label: "Guardian Birth Date", kind: "date" },
    "guardian.phone": { label: "Guardian Phone", kind: "text" },
    "guardian.address": { label: "Guardian Address", kind: "text" },
};

// The key of the form field that holds each confirmable value (Candidate details / Additional details forms).
const RECORD_KEY: Record<string, string> = {
    "basic.surname": "surname", "basic.otherNames": "otherNames", "basic.sex": "sex", "basic.birthDate": "dateOfBirth", "basic.birthPlace": "placeOfBirth",
    "contact.address": "address", "contact.alternativePhone": "contactNumber", "passport.issueDate": "passportIssueDate", "passport.expiryDate": "passportExpiryDate",
    "qualifications.experience": "jobExperience", "qualifications.jobCategory": "jobTypes",
    "basic.fullName": "nameAsInPassport", "measurements.shirtSize": "tshirtSize", "measurements.waistSize": "pantSize", "measurements.shoeSize": "shoeSize",
    "family.father.birthDate": "fatherBirthday", "family.mother.birthDate": "motherBirthday",
    "family.fatherAlive": "fatherAlive", "family.motherAlive": "motherAlive",
    "basic.civilStatus": "maritalStatus", "family.father.fullName": "fatherFullName", "family.mother.fullName": "motherFullName",
    "family.spouse.fullName": "wifeFullName", "family.spouse.birthDate": "wifeBirthday",
    "family.child1": "child1Name", "family.child2": "child2Name", "family.child3": "child3Name", "qualifications.otherSkills1": "otherJobSkills",
    "basic.bloodGroup": "bloodGroup", "basic.height": "height", "basic.weight": "weightKg", "basic.drivingLicence": "drivingLicence",
    "basic.canReadDrawings": "canReadDrawings", "basic.teamLeadingSkills": "teamLeadingSkills", "basic.otherLanguages": "otherLanguages",
    "contact.email": "email", "contact.city": "city", "contact.district": "district", "contact.dsDivision": "dsDivision", "contact.gnDivision": "gnDivision",
    "contact.cityInRomania": "cityInRomania", "qualifications.jobCategoryOther": "otherJobCategory", "qualifications.otherSkills2": "otherJobSkills2",
    "qualifications.englishKnowledge": "englishKnowledge", "family.father.passportNumber": "fatherPassportNumber", "family.mother.passportNumber": "motherPassportNumber",
    "family.spouse.passportNumber": "spousePassportNumber", "guardian.name": "guardianName", "guardian.relationship": "guardianRelationship", "guardian.nic": "guardianNic",
    "guardian.birthDate": "guardianBirthday", "guardian.phone": "guardianPhone", "guardian.address": "guardianAddress",
};

// Folds a refreshed record into a form that may hold unsaved typing. A field the record changed takes the new
// value only if the Admin has not edited it (it still equals the old record value), or if it is a field the Admin
// just confirmed. Every other edited field is left exactly as typed.
export function mergeRefreshed<T extends Record<string, unknown>>(current: T, previous: T, next: T, forced: readonly string[] = []): T {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const merged = { ...current };
    for (const key of Object.keys(next) as (keyof T & string)[]) {
        if (same(previous[key], next[key])) continue;
        if (forced.includes(key) || same(current[key], previous[key])) merged[key] = next[key];
    }
    return merged;
}

export function display(field: string, value: string | null): string {
    if (value === null || value === "") return "Not recorded";
    if (field === "qualifications.englishKnowledge") return englishLevelLabel(value);
    const kind = CONFIRMABLE_LABELS[field]?.kind ?? "text";
    return kind === "date" ? formatDay(value) : kind === "code" ? humanize(value) : value;
}

type Action = "confirm" | "reject";
type Context = {
    pending: ReadonlyMap<string, PendingChange>;
    rejected: ReadonlySet<string>;
    canConfirm: boolean;
    ask: (change: PendingChange, action: Action) => void;
    // Confirm All / Reject All: every pending change at once (one server transaction).
    askAll: (action: Action) => void;
    takeConfirmed: (keys: readonly string[]) => string[];
    // The field the page was opened for (the Candidates list's "!", ?field=), highlighted more strongly.
    focusField: string | null;
};
const SubmittedChanges = createContext<Context | null>(null);

export function SubmittedChangesProvider({ pending, rejected = [], canConfirm, passportId, token, onConfirmed, focusField = null, children }: {
    pending: readonly PendingChange[];
    // Fields whose candidate-submitted change staff already rejected.
    rejected?: readonly string[];
    canConfirm: boolean;
    passportId: string;
    token: string | null;
    // Told after a confirmation (or a refused one) so the record and the hints are reloaded.
    onConfirmed: () => void;
    focusField?: string | null;
    children: ReactNode;
}) {
    const [asking, setAsking] = useState<{ change: PendingChange; action: Action } | null>(null);
    // Confirm All / Reject All: the changes listed when the dialog opened are exactly what is sent.
    const [askingAll, setAskingAll] = useState<{ changes: readonly PendingChange[]; action: Action } | null>(null);
    // Fields the Admin marked with "x" in that dialog: they are left out of the request and stay Pending.
    const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
    const toggleExcluded = (field: string) => setExcluded((previous) => {
        const next = new Set(previous);
        if (!next.delete(field)) next.add(field);
        return next;
    });
    // Form keys the Admin just confirmed: the forms take them once the refreshed record arrives.
    const confirmedKeys = useRef(new Set<string>());
    const takeConfirmed = useCallback((keys: readonly string[]) => {
        const taken = keys.filter((key) => confirmedKeys.current.has(key));
        for (const key of taken) confirmedKeys.current.delete(key);
        return taken;
    }, []);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const value = useMemo<Context>(() => ({
        pending: new Map(pending.map((change) => [change.field, change])),
        rejected: new Set(rejected),
        canConfirm: canConfirm && Boolean(token),
        ask: (change, action) => { setError(null); setAsking({ change, action }); },
        askAll: (action) => { setError(null); setExcluded(new Set()); setAskingAll({ changes: pending, action }); },
        takeConfirmed,
        focusField,
    }), [pending, rejected, canConfirm, token, takeConfirmed, focusField]);

    const close = () => { if (!busy) { setAsking(null); setAskingAll(null); setError(null); } };
    const reviewAll = async () => {
        // busy also guards a second click before the button re-renders disabled.
        if (!askingAll || !token || busy) return;
        setBusy(true);
        setError(null);
        try {
            const { action } = askingAll;
            // The server decides exactly these fields; the excluded ones are not sent and stay Pending.
            const changes = askingAll.changes.filter((change) => !excluded.has(change.field));
            if (!changes.length) return;
            const body = { changes: changes.map((change) => ({ field: change.field, expectedCurrentValue: change.current, expectedSubmittedValue: change.submitted })) };
            if (action === "confirm") await confirmAllFormFields(token, passportId, body);
            else await rejectAllFormFields(token, passportId, body);
            setAskingAll(null);
            if (action === "confirm") for (const change of changes) if (RECORD_KEY[change.field]) confirmedKeys.current.add(RECORD_KEY[change.field]);
            onConfirmed();
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "The changes could not be saved. Please try again.");
            // Nothing was decided (the server rolls the whole request back): show the current state behind the dialog.
            if (caught instanceof ApiError && caught.status === 409) onConfirmed();
        } finally {
            setBusy(false);
        }
    };
    const confirm = async () => {
        if (!asking || !token) return;
        setBusy(true);
        setError(null);
        try {
            const { change, action } = asking;
            const body = { field: change.field, expectedCurrentValue: change.current, expectedSubmittedValue: change.submitted };
            if (action === "confirm") await confirmFormField(token, passportId, body);
            else await rejectFormField(token, passportId, body);
            setAsking(null);
            // Only a Confirm changes the record; a Revoke leaves every form field exactly as it is.
            if (action === "confirm" && RECORD_KEY[change.field]) confirmedKeys.current.add(RECORD_KEY[change.field]);
            onConfirmed();
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "The change could not be saved. Please try again.");
            // A stale or already-resolved field: show the current state behind the dialog.
            if (caught instanceof ApiError && caught.status === 409) onConfirmed();
        } finally {
            setBusy(false);
        }
    };

    return (
        <SubmittedChanges.Provider value={value}>
            {children}
            {asking && (
                <ActionDialog title={asking.action === "confirm" ? `Accept ${CONFIRMABLE_LABELS[asking.change.field]?.label ?? "field"}?` : `Reject the candidate's ${CONFIRMABLE_LABELS[asking.change.field]?.label ?? "field"}?`} busy={busy} onClose={close}>
                    <dl className="space-y-1 text-body-sm">
                        <div className="flex gap-2"><dt className="w-36 shrink-0 text-ink-muted">Current</dt><dd className="text-ink">{display(asking.change.field, asking.change.current)}</dd></div>
                        <div className="flex gap-2"><dt className="w-36 shrink-0 text-ink-muted">Candidate submitted</dt><dd className="font-medium text-ink">{display(asking.change.field, asking.change.submitted)}</dd></div>
                    </dl>
                    <p className="mt-2 text-label-sm text-ink-muted">{asking.action === "confirm"
                        ? "Only this field is updated in the candidate's record. The submitted form is kept as it is."
                        : "The current value is kept. The candidate's submitted value is dismissed for this field and will not be offered again; the submitted form itself is kept as it is."}</p>
                    <DialogError message={error} />
                    <div className="mt-4 flex justify-end gap-2">
                        <button type="button" className={secondaryButton} disabled={busy} onClick={close}>{error ? "Close" : "Cancel"}</button>
                        {!error && <button type="button" className={primaryButton} disabled={busy} onClick={confirm}>{busy ? (asking.action === "confirm" ? "Accepting…" : "Rejecting…") : asking.action === "confirm" ? "Accept change" : "Reject change"}</button>}
                    </div>
                </ActionDialog>
            )}
            {askingAll && (
                <ActionDialog title={askingAll.action === "confirm" ? `Confirm all ${askingAll.changes.length - excluded.size} Candidate Form changes?` : `Reject all ${askingAll.changes.length - excluded.size} Candidate Form changes?`} busy={busy} onClose={close} size="lg">
                    <ChangesTable changes={askingAll.changes} excluded={excluded} onToggle={busy ? undefined : toggleExcluded} />
                    <p className="mt-3 text-label-sm text-ink-muted">Click x on a field to keep it Pending: it is left out and stays as it is for you to review later.</p>
                    {excluded.size === askingAll.changes.length && <p role="alert" className="mt-2 text-label-sm font-medium text-critical">Every field is excluded. Include at least one field to continue.</p>}
                    <p className="mt-3 text-label-sm text-ink-muted">{askingAll.action === "confirm"
                        ? "Every change listed is applied to the candidate's record, with the same checks as confirming each one. If any one cannot be applied, nothing is changed. The submitted form is kept as it is."
                        : "The current values are kept. Every submitted value listed is dismissed and will not be offered again; the submitted form itself is kept as it is."}</p>
                    <DialogError message={error} />
                    <div className="mt-4 flex justify-end gap-2">
                        <button type="button" className={secondaryButton} disabled={busy} onClick={close}>{error ? "Close" : "Cancel"}</button>
                        {!error && (
                            <button type="button" className={askingAll.action === "confirm" ? primaryButton : dangerSolidButton} disabled={busy || excluded.size === askingAll.changes.length} onClick={reviewAll}>
                                {busy ? (askingAll.action === "confirm" ? "Confirming…" : "Rejecting…") : askingAll.action === "confirm" ? "Confirm all" : "Reject all"}
                            </button>
                        )}
                    </div>
                </ActionDialog>
            )}
        </SubmittedChanges.Provider>
    );
}

// Field / Current / Submitted for the changes a Confirm All / Reject All will decide. A field marked with x
// (excluded) is struck through and says Pending: it is not decided. Without onToggle the x is not offered.
function ChangesTable({ changes, excluded = new Set(), onToggle }: { changes: readonly PendingChange[]; excluded?: ReadonlySet<string>; onToggle?: (field: string) => void }) {
    return (
        <div className="max-h-[55vh] overflow-y-auto overflow-x-hidden rounded-lg border border-border">
            <table className="w-full table-fixed text-left text-body-sm">
                <colgroup>
                    <col className="w-[26%]" />
                    <col className="w-[28%]" />
                    <col className="w-[34%]" />
                    {onToggle && <col className="w-[12%]" />}
                </colgroup>
                <thead className="sticky top-0 bg-canvas text-label-sm text-ink-muted">
                    <tr>
                        <th scope="col" className="px-3 py-2 font-medium">Field</th>
                        <th scope="col" className="px-3 py-2 font-medium">Current</th>
                        <th scope="col" className="px-3 py-2 font-medium">Submitted</th>
                        {onToggle && <th scope="col" className="px-3 py-2 text-right font-medium" title="Keep Pending">Keep</th>}
                    </tr>
                </thead>
                <tbody>
                    {changes.map((change) => {
                        const label = CONFIRMABLE_LABELS[change.field]?.label ?? change.field;
                        const off = excluded.has(change.field);
                        return (
                            <tr key={change.field} data-testid={`change-row-${change.field}`} data-excluded={off ? "true" : undefined} className={`border-t border-border align-top ${off ? "bg-canvas text-ink-muted opacity-60" : ""}`}>
                                <th scope="row" className={`[overflow-wrap:anywhere] px-3 py-2 font-medium ${off ? "line-through" : "text-ink"}`}>
                                    {label}
                                    {off && <span className="ml-2 rounded-full border border-border-strong px-2 py-0.5 text-label-sm font-medium no-underline">Pending</span>}
                                </th>
                                <td className={`[overflow-wrap:anywhere] px-3 py-2 ${off ? "line-through" : "text-ink-muted"}`}>{display(change.field, change.current)}</td>
                                <td className={`[overflow-wrap:anywhere] px-3 py-2 ${off ? "line-through" : "font-medium text-ink"}`}>{display(change.field, change.submitted)}</td>
                                {onToggle && (
                                    <td className="px-3 py-2 text-right">
                                        <button
                                            type="button"
                                            aria-pressed={off}
                                            aria-label={off ? `Include ${label}` : `Keep ${label} Pending`}
                                            title={off ? "Include this field again" : "Keep this field Pending"}
                                            onClick={() => onToggle(change.field)}
                                            className={`size-6 rounded-md border text-body-sm leading-none ${off ? "border-border-strong bg-surface text-ink" : "border-border text-ink-muted hover:bg-canvas"}`}
                                        >
                                            <span aria-hidden="true">×</span>
                                        </button>
                                    </td>
                                )}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

// [Confirm All] [Reject All] in the footer of the Candidate details and Additional details forms, left of
// Cancel. Only for the roles that may review Candidate Form changes, and only while the submission still
// has a pending change: they go away with the last decision. The values themselves stay in the inline
// hints; the dialog lists every change it will decide (Field / Current / Submitted).
export function FormChangesButtons() {
    const context = useContext(SubmittedChanges);
    if (!context?.canConfirm || context.pending.size === 0) return null;
    const count = context.pending.size;
    const summary = count === 1 ? "1 Candidate Form change to review" : `${count} Candidate Form changes to review`;
    return (
        <span data-testid="candidate-form-changes" role="group" aria-label={summary} title={summary} className="flex gap-2">
            <button type="button" className={primaryButton} onClick={() => context.askAll("confirm")}>Confirm All</button>
            <button type="button" className={secondaryButton} onClick={() => context.askAll("reject")}>Reject All</button>
        </span>
    );
}

// Rendered under a field of the record. Nothing unless the candidate submitted a different value.
export function SubmittedHint({ field }: { field: string }) {
    const context = useContext(SubmittedChanges);
    const change = context?.pending.get(field);
    if (context && !change && context.rejected.has(field)) {
        return <p data-testid={`rejected-note-${field}`} className="mt-1 text-label-sm text-ink-muted">Candidate change rejected</p>;
    }
    if (!context || !change) return null;
    const label = CONFIRMABLE_LABELS[field]?.label ?? field;
    return (
        <p data-testid={`submitted-hint-${field}`} className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-label-sm text-review">
            <span>Candidate submitted: <strong className="font-semibold">{display(field, change.submitted)}</strong></span>
            {context.canConfirm && (
                <>
                    <button type="button" aria-label={`Accept ${label}`} onClick={() => context.ask(change, "confirm")} className="rounded-lg border border-review-border bg-review-bg px-2 py-0.5 text-label-sm font-medium text-review hover:opacity-80">
                        Accept
                    </button>
                    <button type="button" aria-label={`Reject ${label}`} onClick={() => context.ask(change, "reject")} className="rounded-lg border border-border-strong bg-surface px-2 py-0.5 text-label-sm font-medium text-ink-soft hover:bg-canvas">
                        Reject
                    </button>
                </>
            )}
        </p>
    );
}

// Whether a field of the record has an unresolved Candidate Form change (pending: shown highlighted),
// and whether it is the one the page was opened for (focused: highlighted more strongly). Both are
// false outside the Candidate page and as soon as the change is confirmed or revoked.
export function useFieldConflict(field?: string): { pending: boolean; focused: boolean } {
    const context = useContext(SubmittedChanges);
    const pending = Boolean(field && context?.pending.has(field));
    return { pending, focused: pending && context?.focusField === field };
}

// For a form of the record: hands over the keys confirmed since the last refresh (none outside the Candidate page).
export function useTakeConfirmed(): (keys: readonly string[]) => string[] {
    const context = useContext(SubmittedChanges);
    return context ? context.takeConfirmed : () => [];
}
