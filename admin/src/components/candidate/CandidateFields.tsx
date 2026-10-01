import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CandidateDetails, CandidateDetailsInput } from "../../api/candidates";

export const fieldControl = "h-10 w-full rounded border border-border-strong bg-surface px-3 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none disabled:bg-canvas disabled:text-ink-muted";
export const textAreaControl = "w-full rounded border border-border-strong bg-surface px-3 py-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none disabled:bg-canvas disabled:text-ink-muted";

export const emptyDetails = (): CandidateDetailsInput => ({
    surname: "", otherNames: "", nic: "", address: "", jobTypes: [], jobExperience: "", dateOfBirth: "", placeOfBirth: "", passportExpiryDate: "",
});

export function detailsFrom(candidate: CandidateDetails["candidate"]): CandidateDetailsInput {
    return {
        surname: candidate.surname ?? "",
        otherNames: candidate.otherNames ?? "",
        nic: candidate.nic ?? "",
        address: candidate.address ?? "",
        jobTypes: candidate.jobTypes,
        jobExperience: candidate.jobExperience ?? "",
        dateOfBirth: candidate.dateOfBirth ?? "",
        placeOfBirth: candidate.placeOfBirth ?? "",
        passportExpiryDate: candidate.passportExpiryDate ?? "",
    };
}

const NIC_PATTERN = /^(\d{9}[VXvx]|\d{12})$/;

// The same rules the server applies (candidateService.js), checked first so
// the admin sees which field to fix. Returns field -> message.
export function validateDetails(value: CandidateDetailsInput): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!value.surname.trim()) errors.surname = "Enter the surname.";
    if (!value.otherNames.trim()) errors.otherNames = "Enter the other names.";
    if (!value.nic.trim()) errors.nic = "Enter the NIC.";
    else if (!NIC_PATTERN.test(value.nic.replace(/\s/g, ""))) errors.nic = "Use 9 digits and V or X, or 12 digits.";
    if (!value.address.trim()) errors.address = "Enter the address.";
    if (!value.jobTypes.length) errors.jobTypes = "Add at least one job type.";
    if (!value.jobExperience.trim()) errors.jobExperience = "Enter the job experience.";
    return errors;
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

// Candidate details: passport details, NIC, address, job types and experience.
// The passport ID is entered once at registration and shown read-only after.
export function CandidateFields({ value, onChange, errors = {}, disabled, passportId }: {
    value: CandidateDetailsInput;
    onChange: (next: CandidateDetailsInput) => void;
    errors?: Record<string, string>;
    disabled?: boolean;
    passportId: { value: string; onChange?: (next: string) => void; error?: string };
}) {
    const id = useId();
    const set = (field: keyof CandidateDetailsInput) => (next: string) => onChange({ ...value, [field]: next });
    const input = (field: Exclude<keyof CandidateDetailsInput, "jobTypes">, props: { type?: string; maxLength?: number } = {}) => (
        <input
            id={`${id}-${field}`}
            type={props.type ?? "text"}
            maxLength={props.maxLength ?? 100}
            value={value[field]}
            disabled={disabled}
            onChange={(event) => set(field)(event.target.value)}
            aria-invalid={Boolean(errors[field])}
            className={`${fieldControl} ${errors[field] ? "border-critical" : ""}`}
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
                    aria-invalid={Boolean(passportId.error)}
                    className={`${fieldControl} ${passportId.onChange ? "" : "bg-canvas text-ink-muted"} ${passportId.error ? "border-critical" : ""}`}
                />
            </Field>
            <Field label="Date of birth" htmlFor={`${id}-dateOfBirth`} error={errors.dateOfBirth}>{input("dateOfBirth", { type: "date" })}</Field>
            <Field label="Place of birth" htmlFor={`${id}-placeOfBirth`} error={errors.placeOfBirth}>{input("placeOfBirth")}</Field>
            <Field label="Passport expiry date" htmlFor={`${id}-passportExpiryDate`} error={errors.passportExpiryDate}>{input("passportExpiryDate", { type: "date" })}</Field>
            <div className="hidden md:block" aria-hidden="true" />
            <Field label="Job type" required htmlFor={`${id}-jobTypes`} error={errors.jobTypes} className="md:col-span-2">
                <JobTypesInput id={`${id}-jobTypes`} value={value.jobTypes} onChange={(next) => onChange({ ...value, jobTypes: next })} disabled={disabled} invalid={Boolean(errors.jobTypes)} />
            </Field>
            <Field label="Job experience" required htmlFor={`${id}-jobExperience`} error={errors.jobExperience} className="md:col-span-2">
                {input("jobExperience", { maxLength: 2000 })}
            </Field>
            <Field label="Address" required htmlFor={`${id}-address`} error={errors.address} className="md:col-span-2">
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
