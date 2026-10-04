import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { SEX_OPTIONS, type CandidateDetails, type CandidateDetailsInput } from "../../api/candidates";

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

// "registration": the WhatsApp number is required; the address (and the
// passport document) are not. "details": saving Candidate Details is never
// blocked by the address or WhatsApp number (completionGaps reports them);
// the stage only completes once they and the passport are on record.
export type DetailsForm = "registration" | "details";

const COMPLETION_REQUIRED = "Required to complete Candidate details.";

// The same rules the server applies (candidateService.js), checked first so
// the admin sees which field to fix. Returns field -> message; any message
// blocks saving. The passport and contact details are optional: only a value
// that is given is checked.
export function validateDetails(value: CandidateDetailsInput, form: DetailsForm = "registration"): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!value.surname.trim()) errors.surname = "Enter the surname.";
    if (!value.otherNames.trim()) errors.otherNames = "Enter the other names.";
    if (!value.nic.trim()) errors.nic = "Enter the NIC.";
    else if (!NIC_PATTERN.test(value.nic.replace(/\s/g, ""))) errors.nic = "Use 9 digits and V or X, or 12 digits.";
    if (form === "registration" && !value.whatsappNumber.trim()) errors.whatsappNumber = "Enter the WhatsApp number.";
    if (!value.jobTypes.length) errors.jobTypes = "Add at least one job type.";
    if (!value.jobExperience.trim()) errors.jobExperience = "Enter the job experience.";
    if (value.passportIssueDate && value.passportExpiryDate && value.passportIssueDate >= value.passportExpiryDate) {
        errors.passportIssueDate = "Must be before the expiry date.";
    }
    for (const field of ["whatsappNumber", "contactNumber"] as const) {
        if (value[field].trim() && !isPhoneNumber(value[field].trim())) errors[field] = "Enter a phone number, e.g. 0771234567.";
    }
    return errors;
}

// Candidate Details: what is still needed to complete the stage (shown under
// the fields, without blocking the save). The passport document is shown by
// its own upload row and the stage status.
export function completionGaps(value: CandidateDetailsInput): Record<string, string> {
    const gaps: Record<string, string> = {};
    if (!value.whatsappNumber.trim()) gaps.whatsappNumber = COMPLETION_REQUIRED;
    if (!value.address.trim()) gaps.address = COMPLETION_REQUIRED;
    return gaps;
}

export function Field({ label, required, error, htmlFor, children, className = "" }: { label: string; required?: boolean; error?: string; htmlFor: string; children: ReactNode; className?: string }) {
    return (
        <div className={className}>
            <label htmlFor={htmlFor} className="mb-1 block text-label-sm text-ink-muted">
                {label}{required && <span className="text-critical"> *</span>}
            </label>
            {children}
            {error && <p className="mt-1 text-label-sm text-critical">{error}</p>}
        </div>
    );
}

// Several job types as chips: Enter or a comma adds the typed one.
function JobTypesInput({ id, value, onChange, disabled, invalid }: { id: string; value: string[]; onChange: (next: string[]) => void; disabled?: boolean; invalid?: boolean }) {
    const [draft, setDraft] = useState("");
    const add = () => {
        const name = draft.replace(/,/g, " ").trim().slice(0, 60);
        if (name && !value.some((v) => v.toLowerCase() === name.toLowerCase()) && value.length < 10) onChange([...value, name]);
        setDraft("");
    };
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add();
        } else if (event.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
        }
    };
    return (
        <div className={`flex min-h-10 flex-wrap items-center gap-1.5 rounded border bg-surface px-2 py-1.5 focus-within:border-primary focus-within:shadow-focus ${invalid ? "border-critical" : "border-border-strong"} ${disabled ? "bg-canvas" : ""}`}>
            {value.map((jobType) => (
                <span key={jobType} className="inline-flex items-center gap-1 rounded bg-canvas-muted px-2 py-0.5 text-label-sm text-ink-soft">
                    {jobType}
                    {!disabled && (
                        <button type="button" onClick={() => onChange(value.filter((v) => v !== jobType))} className="text-ink-subtle hover:text-ink" aria-label={`Remove ${jobType}`}>×</button>
                    )}
                </span>
            ))}
            <input
                id={id}
                value={draft}
                disabled={disabled}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
                onBlur={add}
                placeholder={value.length ? "" : "Type a job type and press Enter"}
                className="min-w-[10rem] flex-1 bg-transparent text-body-sm text-ink focus:outline-none"
            />
        </div>
    );
}

// Candidate details: passport details, NIC, contact numbers, address, job
// types and experience. Required fields are marked; the rest are optional.
// The passport ID is entered once at registration and shown read-only after;
// so is a WhatsApp number already on record (whatsappLocked).
// `form` marks what is required where: the address only for Candidate Details
// (registration doesn't need it), the WhatsApp number on both.
export function CandidateFields({ value, onChange, errors = {}, disabled, passportId, whatsappLocked, form = "registration" }: {
    value: CandidateDetailsInput;
    onChange: (next: CandidateDetailsInput) => void;
    errors?: Record<string, string>;
    disabled?: boolean;
    passportId: { value: string; onChange?: (next: string) => void; onBlur?: () => void; error?: string; hint?: ReactNode };
    whatsappLocked?: boolean;
    form?: DetailsForm;
}) {
    const id = useId();
    const set = (field: keyof CandidateDetailsInput) => (next: string) => onChange({ ...value, [field]: next });
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
            <Field label="Surname" required htmlFor={`${id}-surname`} error={errors.surname}>{input("surname")}</Field>
            <Field label="Other names" required htmlFor={`${id}-otherNames`} error={errors.otherNames}>{input("otherNames")}</Field>
            <Field label="NIC" required htmlFor={`${id}-nic`} error={errors.nic}>{input("nic", { maxLength: 12 })}</Field>
            <Field label="Passport ID" required htmlFor={`${id}-passportId`} error={passportId.error}>
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
            <Field label="Nationality" htmlFor={`${id}-nationality`} error={errors.nationality}>{input("nationality", { maxLength: 60 })}</Field>
            <Field label="Sex" htmlFor={`${id}-sex`} error={errors.sex}>
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
            <Field label="Date of birth" htmlFor={`${id}-dateOfBirth`} error={errors.dateOfBirth}>{input("dateOfBirth", { type: "date" })}</Field>
            <Field label="Place of birth" htmlFor={`${id}-placeOfBirth`} error={errors.placeOfBirth}>{input("placeOfBirth")}</Field>
            <Field label="Passport issue date" htmlFor={`${id}-passportIssueDate`} error={errors.passportIssueDate}>{input("passportIssueDate", { type: "date" })}</Field>
            <Field label="Passport expiry date" htmlFor={`${id}-passportExpiryDate`} error={errors.passportExpiryDate}>{input("passportExpiryDate", { type: "date" })}</Field>
            <Field label="WhatsApp number" required htmlFor={`${id}-whatsappNumber`} error={errors.whatsappNumber}>
                {input("whatsappNumber", { type: "tel", maxLength: 30, readOnly: whatsappLocked })}
                {whatsappLocked && <div className="mt-1 text-label-sm text-ink-muted">Registered WhatsApp numbers cannot be changed.</div>}
            </Field>
            <Field label="Contact number" htmlFor={`${id}-contactNumber`} error={errors.contactNumber}>{input("contactNumber", { type: "tel", maxLength: 30 })}</Field>
            <Field label="Job type" required htmlFor={`${id}-jobTypes`} error={errors.jobTypes} className="md:col-span-2">
                <JobTypesInput id={`${id}-jobTypes`} value={value.jobTypes} onChange={(next) => onChange({ ...value, jobTypes: next })} disabled={disabled} invalid={Boolean(errors.jobTypes)} />
            </Field>
            <Field label="Job experience" required htmlFor={`${id}-jobExperience`} error={errors.jobExperience} className="md:col-span-2">
                {input("jobExperience", { maxLength: 2000 })}
            </Field>
            <Field label="Address" required={form === "details"} htmlFor={`${id}-address`} error={errors.address} className="md:col-span-2">
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
