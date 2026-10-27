import { useId, type ReactNode } from "react";
import { SEX_OPTIONS, type CandidateDetails, type CandidateDetailsInput } from "../../api/candidates";
import { getJobTypeChoices, isNoPreference, jobTypeLabel, NO_PREFERRED_JOB_TYPE } from "../../api/jobs";
import { useAdminResource } from "../../api/useAdminResource";
import { HelpTip } from "../Form";
import { DatePicker } from "../DatePicker";
import { SubmittedHint, useFieldConflict } from "./submittedChanges";

export const fieldControl = "h-10 w-full rounded border border-border-strong bg-surface px-3 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none disabled:bg-canvas disabled:text-ink-muted";
export const textAreaControl = "w-full rounded border border-border-strong bg-surface px-3 py-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none disabled:bg-canvas disabled:text-ink-muted";

export const emptyDetails = (): CandidateDetailsInput => ({
    surname: "", otherNames: "", nic: "", address: "", jobTypes: [], jobExperience: "",
    nationality: "", sex: "", dateOfBirth: "", placeOfBirth: "", passportIssueDate: "", passportExpiryDate: "", whatsappNumber: "", contactNumber: "",
});

export function detailsFrom(candidate: CandidateDetails["candidate"]): CandidateDetailsInput {
    return {
        surname: candidate.surname ?? "",
        otherNames: candidate.otherNames ?? "",
        nic: candidate.nic ?? "",
        address: candidate.address ?? "",
        jobTypes: candidate.jobTypes,
        jobExperience: candidate.jobExperience ?? "",
        nationality: candidate.nationality ?? "",
        sex: candidate.sex ?? "",
        dateOfBirth: candidate.dateOfBirth ?? "",
        placeOfBirth: candidate.placeOfBirth ?? "",
        passportIssueDate: candidate.passportIssueDate ?? "",
        passportExpiryDate: candidate.passportExpiryDate ?? "",
        whatsappNumber: candidate.whatsappNumber ?? "",
        contactNumber: candidate.contactNumber ?? "",
    };
}

const NIC_PATTERN = /^(\d{9}[VXvx]|\d{12})$/;
// 8 to 15 digits once spaces, dashes, "+" and a leading "00" are removed
// (the server stores the normalized number).
const isPhoneNumber = (value: string) => {
    const digits = value.replace(/\D/g, "").replace(/^00/, "");
    return /^[\d\s()+-]+$/.test(value) && digits.length >= 8 && digits.length <= 15;
};

// WhatsApp numbers are stored as the server keeps them: international digits
// without "+", e.g. 94771234567, 919876543210 (normalizePhoneNumber, src/utils/phoneNumber.js).
// The form shows "+" as a fixed prefix and the user types the country code and number.
export const WHATSAPP_PREFIX = "+";
const WHATSAPP_STORED = /^[1-9]\d{7,14}$/;

// Converts user input into the stored international digits format.
// Strips non-digits, leading "+", and international "00" prefix.
export function whatsappFromInput(input: string): string {
    let digits = input.replace(/\D/g, "");
    if (digits.startsWith("00")) {
        digits = digits.slice(2);
    }
    return digits.slice(0, 15);
}

// Kept for backward compatibility with existing imports.
export const whatsappFromLocal = whatsappFromInput;

// A stored number's digits after "+", or normalized international digits for older records.
export function whatsappLocalPart(stored: string): string {
    if (!stored) return "";
    let digits = stored.replace(/\D/g, "");
    if (digits.startsWith("00")) {
        digits = digits.slice(2);
    }
    if (/^07\d{8}$/.test(digits)) {
        digits = "94" + digits.slice(1);
    } else if (/^7\d{8}$/.test(digits)) {
        digits = "94" + digits;
    }
    return digits.slice(0, 15);
}

// "registration": the WhatsApp number is required. "details": saving
// Candidate Details is never blocked by a missing WhatsApp number
// (completionGaps reports it); the stage only completes once it and the
// passport are on record. The address is optional everywhere; the passport
// issue and expiry dates and the job experience are required on both, except
// for `initial`: registering a NEW candidate needs only surname, other names,
// NIC, passport ID, job type and WhatsApp number (the server's rule for
// creating, candidateService.js parseCandidateBody).
export type DetailsForm = "registration" | "details";

const COMPLETION_REQUIRED = "Required to complete Candidate details.";

// The same rules the server applies (candidateService.js), checked first so
// the admin sees which field to fix. Returns field -> message; any message
// blocks saving. The passport and contact details are optional: only a value
// that is given is checked.
export function validateDetails(value: CandidateDetailsInput, form: DetailsForm = "registration", { whatsappLocked = false, initial = false }: { whatsappLocked?: boolean; initial?: boolean } = {}): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!value.surname.trim()) errors.surname = "Enter the surname.";
    if (!value.otherNames.trim()) errors.otherNames = "Enter the other names.";
    if (!value.nic.trim()) errors.nic = "Enter the NIC.";
    else if (!NIC_PATTERN.test(value.nic.replace(/\s/g, ""))) errors.nic = "Use 9 digits and V or X, or 12 digits.";
    if (form === "registration" && !value.whatsappNumber.trim()) errors.whatsappNumber = "Enter the WhatsApp number.";
    if (!value.jobTypes.length) errors.jobTypes = "Add at least one job type.";
    if (!initial) {
        if (!value.jobExperience.trim()) errors.jobExperience = "Enter the job experience.";
        if (!value.passportIssueDate) errors.passportIssueDate = "Enter the passport issue date.";
        if (!value.passportExpiryDate) errors.passportExpiryDate = "Enter the passport expiry date.";
    }
    if (value.passportIssueDate && value.passportExpiryDate && value.passportIssueDate >= value.passportExpiryDate) {
        errors.passportIssueDate = "Must be before the expiry date.";
    }
    // A number already on record is read-only and kept as it is.
    if (!whatsappLocked && value.whatsappNumber && !WHATSAPP_STORED.test(value.whatsappNumber)) {
        errors.whatsappNumber = "Enter the mobile number with country code after +, e.g. 94771234567.";
    }
    if (value.contactNumber.trim() && !isPhoneNumber(value.contactNumber.trim())) errors.contactNumber = "Enter a phone number, e.g. 0771234567.";
    return errors;
}

// Candidate Details: what is still needed to complete the stage (shown under
// the fields, without blocking the save). The passport document is shown by
// its own upload row and the stage status.
export function completionGaps(value: CandidateDetailsInput): Record<string, string> {
    const gaps: Record<string, string> = {};
    if (!value.whatsappNumber.trim()) gaps.whatsappNumber = COMPLETION_REQUIRED;
    return gaps;
}

// submitted: the Candidate Form path of this field; shows "Candidate submitted: ... [Confirm]" when the candidate sent a different value.
// While the field has an unresolved Candidate Form change it is outlined (more strongly when it is the
// field the page was opened for); the outline goes as soon as the change is confirmed or revoked.
export function Field({ label, required, error, htmlFor, children, className = "", help, submitted }: { label: string; required?: boolean; error?: string; htmlFor: string; children: ReactNode; className?: string; help?: string; submitted?: string }) {
    const text = <>{label}{required && <span className="text-critical"> *</span>}</>;
    const conflict = useFieldConflict(submitted);
    const highlight = conflict.focused
        ? "rounded-md bg-critical-bg p-2 -m-2 ring-2 ring-critical"
        : conflict.pending ? "rounded-md bg-review-bg p-2 -m-2 ring-1 ring-review-border" : "";
    return (
        <div className={`${className} ${highlight}`.trim()} data-conflict-field={submitted} data-conflict={conflict.pending ? (conflict.focused ? "focused" : "pending") : undefined}>
            {help ? (
                <div className="mb-1 flex items-center gap-1.5">
                    <label htmlFor={htmlFor} className="block text-label-sm text-ink-muted">{text}</label>
                    <HelpTip label={label} text={help} />
                </div>
            ) : (
                <label htmlFor={htmlFor} className="mb-1 block text-label-sm text-ink-muted">{text}</label>
            )}
            {children}
            {submitted && <SubmittedHint field={submitted} />}
            {error && <p className="mt-1 text-label-sm text-critical">{error}</p>}
        </div>
    );
}

// Field hints. They describe the rules the server applies.
export const FIELD_HINTS = {
    passportId: "Passport number must start with P or N followed by 7 digits. Example: P1234567",
    whatsappNumber: "The mobile number with country code after + (e.g. 94771234567, 919876543210). It can't be changed once saved.",
    passportIssueDate: "As printed on the passport. Required, and before the expiry date.",
    passportExpiryDate: "As printed on the passport. Required, and after the issue date.",
} as const;

// The WhatsApp number: "+" fixed in front, the rest typed. A number on
// record is read-only.
function WhatsAppInput({ id, value, onChange, disabled, locked, invalid }: { id: string; value: string; onChange: (next: string) => void; disabled?: boolean; locked?: boolean; invalid?: boolean }) {
    const prefixId = `${id}-prefix`;
    const displayValue = locked ? whatsappLocalPart(value) : (value.startsWith("+") ? value.slice(1) : value);
    return (
        <div className="flex">
            <span aria-hidden="true" className="inline-flex h-10 shrink-0 items-center rounded-l border border-r-0 border-border-strong bg-canvas px-3 text-body-sm text-ink-muted">
                +
            </span>
            <span id={prefixId} className="sr-only">Prefix +</span>
            <input
                id={id}
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                maxLength={20}
                placeholder="94771234567"
                value={displayValue}
                disabled={disabled && !locked}
                readOnly={locked}
                aria-describedby={prefixId}
                aria-invalid={invalid}
                onChange={(event) => onChange(whatsappFromInput(event.target.value))}
                className={`${fieldControl} min-w-0 rounded-l-none ${locked ? "bg-canvas text-ink-muted" : ""} ${invalid ? "border-critical" : ""}`}
            />
        </div>
    );
}

// Several job types as chips: Enter or a comma adds the typed one.
const MAX_JOB_TYPES = 10;

// The candidate's job type preferences: chosen from the ACTIVE job types
// (Settings > Job Types) or "No Preferred Type" (alone: it means any type).
// A value the candidate already has but the list no longer offers (saved before
// the list, or deactivated since) stays as a chip, marked, and is kept on save.
function JobTypesInput({ id, value, onChange, disabled, invalid }: { id: string; value: string[]; onChange: (next: string[]) => void; disabled?: boolean; invalid?: boolean }) {
    const choices = useAdminResource("job-type-choices", (token, signal) => getJobTypeChoices(token, signal));
    const active = choices.data?.jobTypes ?? [];
    const has = (name: string) => value.some((v) => v.toLowerCase() === name.toLowerCase());
    const noPreference = value.some(isNoPreference);
    const available = active.filter((name) => !has(name));
    const pick = (choice: string) => {
        if (!choice) return;
        if (choice === NO_PREFERRED_JOB_TYPE.code) onChange([NO_PREFERRED_JOB_TYPE.code]);
        else if (value.length < MAX_JOB_TYPES || noPreference) onChange([...value.filter((v) => !isNoPreference(v)), choice]);
    };
    const notListed = (v: string) => !isNoPreference(v) && choices.data !== null && !active.some((name) => name.toLowerCase() === v.toLowerCase());
    return (
        <div>
            <div className={`flex min-h-10 flex-wrap items-center gap-1.5 rounded border bg-surface px-2 py-1.5 focus-within:border-primary focus-within:shadow-focus ${invalid ? "border-critical" : "border-border-strong"} ${disabled ? "bg-canvas" : ""}`}>
                {value.map((jobType) => (
                    <span key={jobType} className="inline-flex items-center gap-1 rounded bg-canvas-muted px-2 py-0.5 text-label-sm text-ink-soft" title={notListed(jobType) ? "Not in the current job type list (kept as saved)" : undefined}>
                        {jobTypeLabel(jobType)}
                        {notListed(jobType) && <span className="text-ink-subtle">(not in list)</span>}
                        {!disabled && (
                            <button type="button" onClick={() => onChange(value.filter((v) => v !== jobType))} className="text-ink-subtle hover:text-ink" aria-label={`Remove ${jobTypeLabel(jobType)}`}>×</button>
                        )}
                    </span>
                ))}
                <select
                    id={id}
                    value=""
                    disabled={disabled || choices.status === "loading"}
                    aria-invalid={invalid}
                    onChange={(event) => pick(event.target.value)}
                    className="min-w-[10rem] flex-1 bg-transparent text-body-sm text-ink focus:outline-none"
                >
                    <option value="">{choices.status === "loading" ? "Loading job types…" : value.length ? "Add another job type…" : "Select a job type…"}</option>
                    {!noPreference && <option value={NO_PREFERRED_JOB_TYPE.code}>{NO_PREFERRED_JOB_TYPE.label}</option>}
                    {available.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
            </div>
            {choices.status === "error" && (
                <p role="alert" className="mt-1 text-label-sm text-critical">
                    The job types could not be loaded. <button type="button" onClick={choices.reload} className="underline">Try again</button>
                </p>
            )}
        </div>
    );
}

// Candidate details: passport details, NIC, contact numbers, address, job
// types and experience. Required fields are marked; the rest are optional.
// The passport ID is entered once at registration and shown read-only after;
// so is a WhatsApp number already on record (whatsappLocked). The required
// marks follow validateDetails: initialRegistration (a NEW candidate) marks
// only the six registration fields; otherwise the passport dates and the job
// experience are marked too.
export function CandidateFields({ value, onChange, errors = {}, disabled, passportId, whatsappLocked, initialRegistration = false }: {
    value: CandidateDetailsInput;
    onChange: (next: CandidateDetailsInput) => void;
    errors?: Record<string, string>;
    disabled?: boolean;
    passportId: { value: string; onChange?: (next: string) => void; onBlur?: () => void; error?: string; hint?: ReactNode };
    whatsappLocked?: boolean;
    initialRegistration?: boolean;
}) {
    const id = useId();
    const laterRequired = !initialRegistration;
    const set = (field: keyof CandidateDetailsInput) => (next: string) => onChange({ ...value, [field]: next });
    // A calendar field (value is always YYYY-MM-DD). Same rules as before: required only where the label says so.
    const dateInput = (field: "dateOfBirth" | "passportIssueDate" | "passportExpiryDate", required = false) => (
        <DatePicker
            id={`${id}-${field}`}
            value={value[field]}
            onChange={set(field)}
            disabled={disabled}
            required={required}
            invalid={Boolean(errors[field])}
            className={`${fieldControl} ${errors[field] ? "border-critical" : ""}`}
        />
    );
    const input = (field: Exclude<keyof CandidateDetailsInput, "jobTypes" | "sex">, props: { type?: string; maxLength?: number; readOnly?: boolean } = {}) => (
        <input
            id={`${id}-${field}`}
            type={props.type ?? "text"}
            maxLength={props.maxLength ?? 100}
            value={value[field]}
            disabled={disabled && !props.readOnly}
            readOnly={props.readOnly}
            onChange={(event) => set(field)(event.target.value)}
            aria-invalid={Boolean(errors[field])}
            className={`${fieldControl} ${props.readOnly ? "bg-canvas text-ink-muted" : ""} ${errors[field] ? "border-critical" : ""}`}
        />
    );

    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* The six fields registration requires, first: Surname | Other names, NIC | WhatsApp number,
                Passport ID | Job type. Then the optional details. One layout for new and existing candidates. */}
            <Field label="Surname" required htmlFor={`${id}-surname`} error={errors.surname} submitted="basic.surname">{input("surname")}</Field>
            <Field label="Other names" required htmlFor={`${id}-otherNames`} error={errors.otherNames} submitted="basic.otherNames">{input("otherNames")}</Field>
            <Field label="NIC" required htmlFor={`${id}-nic`} error={errors.nic}>{input("nic", { maxLength: 12 })}</Field>
            <Field label="WhatsApp number" required htmlFor={`${id}-whatsappNumber`} error={errors.whatsappNumber} help={FIELD_HINTS.whatsappNumber}>
                <WhatsAppInput id={`${id}-whatsappNumber`} value={value.whatsappNumber} onChange={set("whatsappNumber")} disabled={disabled} locked={whatsappLocked} invalid={Boolean(errors.whatsappNumber)} />
                {whatsappLocked && <div className="mt-1 text-label-sm text-ink-muted">Registered WhatsApp numbers cannot be changed.</div>}
            </Field>
            <Field label="Passport ID" required htmlFor={`${id}-passportId`} error={passportId.error} help={FIELD_HINTS.passportId}>
                <input
                    id={`${id}-passportId`}
                    value={passportId.value}
                    maxLength={20}
                    readOnly={!passportId.onChange}
                    disabled={disabled && Boolean(passportId.onChange)}
                    onChange={(event) => passportId.onChange?.(event.target.value.toUpperCase())}
                    onBlur={passportId.onBlur}
                    aria-invalid={Boolean(passportId.error)}
                    className={`${fieldControl} ${passportId.onChange ? "" : "bg-canvas text-ink-muted"} ${passportId.error ? "border-critical" : ""}`}
                />
                {passportId.hint && <div className="mt-1 text-label-sm" aria-live="polite">{passportId.hint}</div>}
            </Field>
            <Field label="Job type" required htmlFor={`${id}-jobTypes`} error={errors.jobTypes} submitted="qualifications.jobCategory">
                <JobTypesInput id={`${id}-jobTypes`} value={value.jobTypes} onChange={(next) => onChange({ ...value, jobTypes: next })} disabled={disabled} invalid={Boolean(errors.jobTypes)} />
            </Field>
            <Field label="Nationality" htmlFor={`${id}-nationality`} error={errors.nationality}>{input("nationality", { maxLength: 60 })}</Field>
            <Field label="Sex" htmlFor={`${id}-sex`} error={errors.sex} submitted="basic.sex">
                <select
                    id={`${id}-sex`}
                    value={value.sex}
                    disabled={disabled}
                    onChange={(event) => onChange({ ...value, sex: SEX_OPTIONS.find((o) => o.value === event.target.value)?.value ?? "" })}
                    className={fieldControl}
                >
                    <option value="">—</option>
                    {SEX_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
            </Field>
            <Field label="Date of birth" htmlFor={`${id}-dateOfBirth`} error={errors.dateOfBirth} submitted="basic.birthDate">{dateInput("dateOfBirth")}</Field>
            <Field label="Place of birth" htmlFor={`${id}-placeOfBirth`} error={errors.placeOfBirth} submitted="basic.birthPlace">{input("placeOfBirth")}</Field>
            <Field label="Passport issue date" required={laterRequired} htmlFor={`${id}-passportIssueDate`} error={errors.passportIssueDate} help={FIELD_HINTS.passportIssueDate} submitted="passport.issueDate">{dateInput("passportIssueDate", laterRequired)}</Field>
            <Field label="Passport expiry date" required={laterRequired} htmlFor={`${id}-passportExpiryDate`} error={errors.passportExpiryDate} help={FIELD_HINTS.passportExpiryDate} submitted="passport.expiryDate">{dateInput("passportExpiryDate", laterRequired)}</Field>
            <Field label="Contact number" htmlFor={`${id}-contactNumber`} error={errors.contactNumber} submitted="contact.alternativePhone">{input("contactNumber", { type: "tel", maxLength: 30 })}</Field>
            <Field label="Job experience" required={laterRequired} htmlFor={`${id}-jobExperience`} error={errors.jobExperience} className="md:col-span-2" submitted="qualifications.experience">
                {input("jobExperience", { maxLength: 2000 })}
            </Field>
            <Field label="Address" htmlFor={`${id}-address`} error={errors.address} className="md:col-span-2" submitted="contact.address">
                <textarea
                    id={`${id}-address`}
                    rows={2}
                    maxLength={500}
                    value={value.address}
                    disabled={disabled}
                    onChange={(event) => set("address")(event.target.value)}
                    aria-invalid={Boolean(errors.address)}
                    className={`${textAreaControl} ${errors.address ? "border-critical" : ""}`}
                />
            </Field>
        </div>
    );
}
