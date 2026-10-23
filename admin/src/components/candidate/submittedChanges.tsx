import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../../api/client";
import { confirmFormField, rejectFormField, type PendingChange } from "../../api/candidates";
import { ActionDialog, DialogError, primaryButton, secondaryButton } from "../Dialog";
import { formatDay, humanize } from "../format";

// Per-field "Candidate submitted: <value> [Confirm]" under the fields of the
// candidate's record. The record's own value stays the main value; a hint is
// shown only when the candidate submitted a DIFFERENT value for a field that has a
// real home in the record (the server decides which: candidateFormFieldConfirmService.js).
// Confirm applies that ONE field after a confirmation; Revoke dismisses the proposal and leaves the record as it
// is (it is not an undo of a Confirm). Both are final for that field and share one review state on the server.
// Roles that cannot confirm still see the hint, without the button.

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
    "measurements.shoeSize": { label: "Shoe size", kind: "text" },
    "family.father.birthDate": { label: "Father birthday", kind: "date" },
    "family.mother.birthDate": { label: "Mother birthday", kind: "date" },
};

// The key of the form field that holds each confirmable value (Candidate details / Additional details forms).
const RECORD_KEY: Record<string, string> = {
    "basic.surname": "surname", "basic.otherNames": "otherNames", "basic.sex": "sex", "basic.birthDate": "dateOfBirth", "basic.birthPlace": "placeOfBirth",
    "contact.address": "address", "contact.alternativePhone": "contactNumber", "passport.issueDate": "passportIssueDate", "passport.expiryDate": "passportExpiryDate",
    "qualifications.experience": "jobExperience",
    "basic.fullName": "nameAsInPassport", "measurements.shirtSize": "tshirtSize", "measurements.waistSize": "pantSize", "measurements.shoeSize": "shoeSize",
    "family.father.birthDate": "fatherBirthday", "family.mother.birthDate": "motherBirthday",
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

function display(field: string, value: string | null): string {
    if (value === null || value === "") return "Not recorded";
    const kind = CONFIRMABLE_LABELS[field]?.kind ?? "text";
    return kind === "date" ? formatDay(value) : kind === "code" ? humanize(value) : value;
}

type Action = "confirm" | "reject";
type Context = {
    pending: ReadonlyMap<string, PendingChange>;
    rejected: ReadonlySet<string>;
    canConfirm: boolean;
    ask: (change: PendingChange, action: Action) => void;
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
        takeConfirmed,
        focusField,
    }), [pending, rejected, canConfirm, token, takeConfirmed, focusField]);

    const close = () => { if (!busy) { setAsking(null); setError(null); } };
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
                <ActionDialog title={asking.action === "confirm" ? `Update ${CONFIRMABLE_LABELS[asking.change.field]?.label ?? "field"}?` : `Revoke the candidate's ${CONFIRMABLE_LABELS[asking.change.field]?.label ?? "field"}?`} busy={busy} onClose={close}>
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
                        {!error && <button type="button" className={primaryButton} disabled={busy} onClick={confirm}>{busy ? (asking.action === "confirm" ? "Confirming…" : "Rejecting…") : asking.action === "confirm" ? "Confirm change" : "Revoke change"}</button>}
                    </div>
                </ActionDialog>
            )}
        </SubmittedChanges.Provider>
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
                    <button type="button" aria-label={`Confirm ${label}`} onClick={() => context.ask(change, "confirm")} className="rounded border border-review-border bg-review-bg px-2 py-0.5 text-label-sm font-medium text-review hover:opacity-80">
                        Confirm
                    </button>
                    <button type="button" aria-label={`Revoke ${label}`} onClick={() => context.ask(change, "reject")} className="rounded border border-border-strong bg-surface px-2 py-0.5 text-label-sm font-medium text-ink-soft hover:bg-canvas">
                        Revoke
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
