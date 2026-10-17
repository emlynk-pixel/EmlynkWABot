import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { ApiError } from "../../api/client";
import {
    MARITAL_STATUS_OPTIONS,
    PANT_SIZE_PRESETS,
    SHOE_SIZE_PRESETS,
    TSHIRT_SIZES,
    saveAdditionalDetails,
    type AdditionalDetails,
    type AdditionalDetailsView,
} from "../../api/candidates";
import { todayInSriLanka } from "../format";
import { DatePicker } from "../DatePicker";
import { DialogError, primaryButton, secondaryButton } from "../Dialog";
import { ErrorState, LoadingState } from "../States";
import { Field, fieldControl, textAreaControl } from "./CandidateFields";
import type { CandidateJobAssignment } from "../../api/jobs";
import { ShareFormButton } from "./ShareFormButton";
import { mergeRefreshed, useTakeConfirmed } from "./submittedChanges";

// Additional Details tab of a candidate: passport and personal details,
// clothing sizes, parents, marital and family details, other job skills.
// Saved separately from the candidate's own record, which is never changed
// here: a new form is filled in from it (name, address, birthday) as a
// starting point only. The server checks everything again.

type Key = keyof AdditionalDetails;
// Every field as the form holds it: text; Yes / No answers as "yes" | "no" | "".
type Form = Record<Key, string>;

const KEYS: Key[] = [
    "nameAsInPassport", "permanentAddress", "birthday", "tshirtSize", "pantSize", "shoeSize",
    "fatherAlive", "fatherFullName", "fatherBirthday", "motherAlive", "motherFullName", "motherBirthday",
    "maritalStatus", "wifeFullName", "wifeBirthday", "child1Name", "child2Name", "child3Name", "otherJobSkills",
];
const BOOLEAN_KEYS: Key[] = ["fatherAlive", "motherAlive"];
const SUGGESTED_LABELS: Record<string, string> = { nameAsInPassport: "name according to passport", permanentAddress: "permanent address", birthday: "birthday" };
const CUSTOM_SIZE = /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,9}$/;

const emptyForm = (): Form => Object.fromEntries(KEYS.map((key) => [key, ""])) as Form;

function formFrom(details: AdditionalDetails): Form {
    const form = emptyForm();
    for (const key of KEYS) {
        const value = details[key];
        form[key] = typeof value === "boolean" ? (value ? "yes" : "no") : value ?? "";
    }
    return form;
}

// What is saved: blanks as null, and details that go with a hidden answer
// (a wife when not married, children when single) cleared rather than kept out of sight.
function payloadOf(form: Form): AdditionalDetails {
    const value = (key: Key) => form[key].trim() || null;
    const payload = Object.fromEntries(KEYS.map((key) => [key, BOOLEAN_KEYS.includes(key) ? (form[key] ? form[key] === "yes" : null) : value(key)])) as AdditionalDetails;
    // A parent's name and birthday are kept whatever the alive answer.
    if (form.maritalStatus === "SINGLE") Object.assign(payload, { child1Name: null, child2Name: null, child3Name: null });
    if (form.maritalStatus !== "MARRIED") Object.assign(payload, { wifeFullName: null, wifeBirthday: null });
    return payload;
}

// The server's rules (candidateAdditionalDetailsService.js), checked first so
// the right field is marked. Returns field -> message.
export function validateAdditionalDetails(form: Form, today = todayInSriLanka()): Partial<Record<Key, string>> {
    const errors: Partial<Record<Key, string>> = {};
    if (form.fatherAlive === "yes" && !form.fatherFullName.trim()) errors.fatherFullName = "Enter the father's full name.";
    if (form.motherAlive === "yes" && !form.motherFullName.trim()) errors.motherFullName = "Enter the mother's full name.";
    if (form.maritalStatus === "MARRIED" && !form.wifeFullName.trim()) errors.wifeFullName = "Enter the wife's full name.";
    const children = form.maritalStatus !== "SINGLE";
    if (children && form.child2Name.trim() && !form.child1Name.trim()) errors.child2Name = "Enter the 1st child's name first.";
    if (children && form.child3Name.trim() && !form.child2Name.trim()) errors.child3Name = "Enter the 2nd child's name first.";
    for (const key of ["pantSize", "shoeSize"] as const) {
        if (form[key].trim() && !CUSTOM_SIZE.test(form[key].trim())) errors[key] = "Up to 10 letters, digits, spaces, dots, slashes or dashes.";
    }
    for (const key of ["birthday", "fatherBirthday", "motherBirthday", "wifeBirthday"] as const) {
        if (form[key] && form[key] > today) errors[key] = "This date is in the future.";
        else if (form[key] && form[key] < "1900-01-01") errors[key] = "This date is before 1900.";
    }
    return errors;
}

const SERVER_MESSAGES: Record<string, string> = { "must not be in the future": "This date is in the future." };
const serverMessage = (message: string) => SERVER_MESSAGES[message] ?? `This value ${message}.`;

// What the page loaded for this candidate (it also needs it for the stepper,
// so it is fetched once, there). data: null until it has loaded for THIS candidate.
export type AdditionalDetailsLoad = {
    data: AdditionalDetailsView | null;
    status: "loading" | "success" | "error";
    errorMessage: string | null;
    reload: () => void;
};

// onSaved: told after each save (the page's Additional details step).
// currentJob: the candidate's PROCESSING job (from the Job relation), for the Share Form's job-group link.
export function AdditionalDetailsPanel({ resource, canEdit, onSaved, currentJob = null }: { resource: AdditionalDetailsLoad; canEdit: boolean; onSaved?: (view: AdditionalDetailsView) => void; currentJob?: CandidateJobAssignment | null }) {
    // The version this panel saved last: "Saved" is shown only while that is still the one on screen.
    const [savedVersion, setSavedVersion] = useState<string | null | undefined>(undefined);
    // A save rebuilds the form from what was saved; any other refresh (a confirmed Candidate Form value, Sync) is
    // merged into the open form without discarding what is being typed.
    const [saves, setSaves] = useState(0);

    const data = resource.data;
    if (!data) {
        return resource.status === "error"
            ? <ErrorState message={resource.errorMessage ?? "The additional details could not be loaded."} onRetry={resource.reload} />
            : <LoadingState label="Loading additional details…" />;
    }
    return (
        <AdditionalDetailsForm
            key={saves}
            view={data}
            canEdit={canEdit}
            currentJob={currentJob}
            notice={savedVersion !== undefined && savedVersion === data.updatedDate}
            onSaved={(view) => { setSavedVersion(view.updatedDate); setSaves((n) => n + 1); onSaved?.(view); }}
        />
    );
}

function AdditionalDetailsForm({ view, canEdit, notice, onSaved, currentJob }: {
    view: AdditionalDetailsView;
    canEdit: boolean;
    currentJob: CandidateJobAssignment | null;
    notice: boolean;
    onSaved: (view: AdditionalDetailsView) => void;
}) {
    const { token } = useAuth();
    // A new form starts from the candidate's record (only what it has).
    const autofilled = view.details ? [] : (Object.keys(SUGGESTED_LABELS) as Key[]).filter((key) => view.suggested[key as keyof AdditionalDetailsView["suggested"]]);
    const initial = view.details ? formFrom(view.details) : { ...emptyForm(), ...Object.fromEntries(autofilled.map((key) => [key, view.suggested[key as keyof AdditionalDetailsView["suggested"]] ?? ""])) };
    const [form, setForm] = useState<Form>(initial);
    const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // Cancel remounts the size fields, so a custom-size input follows the restored value.
    const [resets, setResets] = useState(0);
    const baseline = useRef(initial);
    const takeConfirmed = useTakeConfirmed();
    useEffect(() => {
        const previous = baseline.current;
        if (JSON.stringify(previous) === JSON.stringify(initial)) return;
        baseline.current = initial;
        const forced = takeConfirmed(KEYS);
        setForm((current) => mergeRefreshed(current, previous, initial, forced));
        // Size fields keep a custom-value toggle of their own: rebuild them when a size was refreshed.
        if (previous.pantSize !== initial.pantSize || previous.shoeSize !== initial.shoeSize) setResets((n) => n + 1);
    }, [view.updatedDate, view.details]);
    const today = todayInSriLanka();

    const changed = JSON.stringify(form) !== JSON.stringify(initial);
    // Suggestions on a new form can be saved as they are.
    const canSave = changed || (!view.details && autofilled.length > 0);
    const disabled = !canEdit || busy;

    const set = (key: Key) => (value: string) => {
        setForm((previous) => ({ ...previous, [key]: value }));
        setErrors((previous) => ({ ...previous, [key]: undefined }));
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!canEdit || !token) return;
        const found = validateAdditionalDetails(form, today);
        setErrors(found);
        setError(null);
        if (Object.keys(found).length) {
            setError("Check the highlighted fields.");
            return;
        }
        setBusy(true);
        try {
            onSaved(await saveAdditionalDetails(token, view.passportId, payloadOf(form), view.updatedDate));
        } catch (caught) {
            if (caught instanceof ApiError && caught.fieldErrors.length) {
                setErrors(Object.fromEntries(caught.fieldErrors.filter((e) => KEYS.includes(e.field as Key)).map((e) => [e.field, serverMessage(e.message)])));
                setError("Check the highlighted fields.");
            } else {
                setError(caught instanceof ApiError ? caught.message : "The additional details could not be saved.");
            }
        } finally {
            setBusy(false);
        }
    };

    const text = (key: Key, label: string, { required = false, maxLength = 150, placeholder, submitted }: { required?: boolean; maxLength?: number; placeholder?: string; submitted?: string } = {}) => (
        <TextField id={key} label={label} required={required} error={errors[key]} value={form[key]} onChange={set(key)} disabled={disabled} maxLength={maxLength} placeholder={placeholder} submitted={submitted} />
    );
    const dateField = (key: Key, label: string, submitted?: string) => (
        <Field label={label} htmlFor={`ad-${key}`} error={errors[key]} submitted={submitted}>
            <DatePicker id={`ad-${key}`} min="1900-01-01" max={today} value={form[key]} onChange={set(key)} disabled={disabled} invalid={Boolean(errors[key])} className={`${fieldControl} ${errors[key] ? "border-critical" : ""}`} />
        </Field>
    );
    const yesNo = (key: Key, label: string) => (
        <Field label={label} htmlFor={`ad-${key}`}>
            <select id={`ad-${key}`} value={form[key]} onChange={(e) => set(key)(e.target.value)} disabled={disabled} className={fieldControl}>
                <option value="">Not recorded</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
            </select>
        </Field>
    );

    return (
        <form onSubmit={submit} noValidate aria-labelledby="additional-details-title" className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 id="additional-details-title" className="text-headline-sm text-ink">Additional details</h2>
                    <p className="mt-1 text-body-sm text-ink-muted">Saved separately from the candidate&apos;s record, which is not changed here. Every field is optional.</p>
                </div>
                {/* The public Candidate Form for this candidate (link + Passport + NIC). */}
                {canEdit && <ShareFormButton passportId={view.passportId} currentJob={currentJob} />}
            </div>

            {autofilled.length > 0 && (
                <p role="note" className="rounded border border-pending-border bg-pending-bg px-3 py-2 text-body-sm text-ink-soft">
                    Filled in from the candidate&apos;s record: {autofilled.map((key) => SUGGESTED_LABELS[key]).join(", ")}. Check them and save — nothing is stored until you do.
                </p>
            )}

            <Section title="Passport & personal details">
                <Field label="Passport number" htmlFor="ad-passport">
                    <input id="ad-passport" value={view.passportId} readOnly aria-describedby="ad-passport-hint" className={`${fieldControl} bg-canvas text-ink-muted`} />
                    <p id="ad-passport-hint" className="mt-1 text-label-sm text-ink-subtle">The candidate&apos;s passport ID; it can&apos;t be changed here.</p>
                </Field>
                {text("nameAsInPassport", "Name according to passport", { submitted: "basic.fullName" })}
                <div className="sm:col-span-2">
                    <Field label="Permanent address" htmlFor="ad-permanentAddress" error={errors.permanentAddress}>
                        <textarea id="ad-permanentAddress" rows={2} maxLength={500} value={form.permanentAddress} onChange={(e) => set("permanentAddress")(e.target.value)} disabled={disabled} className={textAreaControl} />
                    </Field>
                </div>
                {dateField("birthday", "Birthday")}
            </Section>

            <Section title="Clothing & sizes">
                <Field label="T-shirt size" htmlFor="ad-tshirtSize" error={errors.tshirtSize} submitted="measurements.shirtSize">
                    <select id="ad-tshirtSize" value={form.tshirtSize} onChange={(e) => set("tshirtSize")(e.target.value)} disabled={disabled} className={fieldControl}>
                        <option value="">Not recorded</option>
                        {TSHIRT_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                    </select>
                </Field>
                <SizeField key={`pant-${resets}`} id="pantSize" label="Pant size" submitted="measurements.waistSize" presets={PANT_SIZE_PRESETS} value={form.pantSize} onChange={set("pantSize")} error={errors.pantSize} disabled={disabled} />
                <SizeField key={`shoe-${resets}`} id="shoeSize" label="Shoe size (UK)" submitted="measurements.shoeSize" presets={SHOE_SIZE_PRESETS} value={form.shoeSize} onChange={set("shoeSize")} error={errors.shoeSize} disabled={disabled} />
            </Section>

            <Section title="Father details">
                {yesNo("fatherAlive", "Is father alive?")}
                {text("fatherFullName", "Father full name", { required: form.fatherAlive === "yes" })}
                {dateField("fatherBirthday", "Father birthday", "family.father.birthDate")}
            </Section>

            <Section title="Mother details">
                {yesNo("motherAlive", "Is mother alive?")}
                {text("motherFullName", "Mother full name", { required: form.motherAlive === "yes" })}
                {dateField("motherBirthday", "Mother birthday", "family.mother.birthDate")}
            </Section>

            <Section title="Marital & family details">
                <Field label="Marital status" htmlFor="ad-maritalStatus" error={errors.maritalStatus}>
                    <select id="ad-maritalStatus" value={form.maritalStatus} onChange={(e) => set("maritalStatus")(e.target.value)} disabled={disabled} className={fieldControl}>
                        <option value="">Not recorded</option>
                        {MARITAL_STATUS_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                    </select>
                </Field>
                {form.maritalStatus === "MARRIED" && (
                    <>
                        {text("wifeFullName", "Wife full name", { required: true })}
                        {dateField("wifeBirthday", "Wife birthday")}
                    </>
                )}
                {form.maritalStatus === "SINGLE" ? (
                    (form.child1Name || form.child2Name || form.child3Name) && (
                        <p className="text-body-sm text-ink-muted sm:col-span-2">
                            Child names on record will be removed when you save, because the marital status is Single.
                        </p>
                    )
                ) : (
                    <>
                        {text("child1Name", "1st child name")}
                        {text("child2Name", "2nd child name")}
                        {text("child3Name", "3rd child name")}
                    </>
                )}
            </Section>

            <Section title="Employment / skills">
                <div className="sm:col-span-2">
                    <Field label="Other job skills" htmlFor="ad-otherJobSkills" error={errors.otherJobSkills}>
                        <textarea id="ad-otherJobSkills" rows={3} maxLength={1000} value={form.otherJobSkills} onChange={(e) => set("otherJobSkills")(e.target.value)} disabled={disabled} placeholder="For example: forklift licence, basic welding" className={textAreaControl} />
                    </Field>
                </div>
            </Section>

            <div className="border-t border-border pt-4">
                {notice && !changed && <p role="status" className="text-body-sm text-verified">Additional details saved.</p>}
                <DialogError message={error} />
                {canEdit && (
                    <div className="mt-4 flex justify-end gap-2">
                        <button type="button" onClick={() => { setForm(initial); setErrors({}); setError(null); setResets((n) => n + 1); }} disabled={busy || !changed} className={secondaryButton}>Cancel</button>
                        <button type="submit" disabled={busy || !canSave} className={primaryButton}>{busy ? "Saving…" : "Save additional details"}</button>
                    </div>
                )}
            </div>
        </form>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <fieldset className="rounded border border-border p-4">
            <legend className="px-1 text-label-md font-semibold text-ink">{title}</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
        </fieldset>
    );
}

function TextField({ id, label, required, error, value, onChange, disabled, maxLength, placeholder, submitted }: {
    id: string; label: string; required: boolean; error?: string; value: string; onChange: (value: string) => void; disabled: boolean; maxLength: number; placeholder?: string; submitted?: string;
}) {
    return (
        <Field label={label} required={required} htmlFor={`ad-${id}`} error={error} submitted={submitted}>
            <input id={`ad-${id}`} value={value} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={placeholder} aria-invalid={Boolean(error)} className={`${fieldControl} ${error ? "border-critical" : ""}`} />
        </Field>
    );
}

// A preset from the list, or "Other" with a typed value (e.g. 31, 9.5, EU 43).
function SizeField({ id, label, presets, value, onChange, error, disabled, submitted }: {
    id: string; label: string; presets: readonly string[]; value: string; onChange: (value: string) => void; error?: string; disabled: boolean; submitted?: string;
}) {
    const customId = useId();
    const [custom, setCustom] = useState(Boolean(value) && !presets.includes(value));
    return (
        <Field label={label} htmlFor={`ad-${id}`} error={error} submitted={submitted}>
            <select
                id={`ad-${id}`}
                value={custom ? "__custom" : value}
                onChange={(e) => {
                    const next = e.target.value;
                    setCustom(next === "__custom");
                    onChange(next === "__custom" ? "" : next);
                }}
                disabled={disabled}
                className={fieldControl}
            >
                <option value="">Not recorded</option>
                {presets.map((size) => <option key={size} value={size}>{size}</option>)}
                <option value="__custom">Other (enter size)</option>
            </select>
            {custom && (
                <>
                    <label htmlFor={customId} className="sr-only">{`Custom ${label.toLowerCase()}`}</label>
                    <input id={customId} value={value} maxLength={10} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder="Enter size" aria-invalid={Boolean(error)} className={`${fieldControl} mt-2 ${error ? "border-critical" : ""}`} />
                </>
            )}
        </Field>
    );
}
