import { useId, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../../api/client";
import type { EntityStatus } from "../../api/agents";
import { ActionDialog, DialogError, dangerSolidButton, primaryButton, secondaryButton } from "../Dialog";
import { ToneBadge } from "../StatusBadge";
import { inputClass } from "../ui";

// Shared by Agents and Client Management: status badge, country names, and the
// small form pieces. The country codes are the server's list (src/utils/countries.js,
// the server re-validates every code); names come from the browser's Intl data.

const COUNTRY_CODES = `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT
MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG
UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(/\s+/);

let names: Intl.DisplayNames | null = null;
try {
    names = new Intl.DisplayNames(["en"], { type: "region" });
} catch {
    names = null;
}

export const countryName = (code: string | null | undefined): string => {
    if (!code) return "—";
    try {
        return names?.of(code) ?? code;
    } catch {
        return code;
    }
};

export const COUNTRY_OPTIONS: { code: string; name: string }[] = COUNTRY_CODES
    .map((code) => ({ code, name: countryName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name));

export function EntityStatusBadge({ status }: { status: EntityStatus }) {
    return <ToneBadge tone={status === "ACTIVE" ? "verified" : "pending"}>{status === "ACTIVE" ? "Active" : "Inactive"}</ToneBadge>;
}

export const errorMessage = (caught: unknown) => (caught instanceof ApiError ? caught.message : "Something went wrong. Please try again.");

// A labelled input. `error` is a server-side validation message for the field.
export function TextField({ label, value, onChange, disabled, error, required, type = "text", maxLength = 300, hint }: {
    label: string; value: string; onChange: (value: string) => void; disabled: boolean; error?: string; required?: boolean; type?: string; maxLength?: number; hint?: string;
}) {
    const id = useId();
    return (
        <div>
            <label htmlFor={id} className="text-label-md text-ink">{label}{required ? " *" : <span className="text-ink-muted"> (optional)</span>}</label>
            <input id={id} type={type} value={value} maxLength={maxLength} disabled={disabled} onChange={(event) => onChange(event.target.value)} className={`${inputClass(Boolean(error))} mt-1`} />
            {hint && !error && <p className="mt-1 text-label-sm text-ink-muted">{hint}</p>}
            {error && <p className="mt-1 text-label-sm text-critical">{error}</p>}
        </div>
    );
}

export function CountrySelect({ label = "Country", value, onChange, disabled, error }: { label?: string; value: string; onChange: (code: string) => void; disabled: boolean; error?: string }) {
    const id = useId();
    return (
        <div>
            <label htmlFor={id} className="text-label-md text-ink">{label} *</label>
            <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className={`${inputClass(Boolean(error))} mt-1`}>
                <option value="">Select a country…</option>
                {COUNTRY_OPTIONS.map((option) => <option key={option.code} value={option.code}>{option.name}</option>)}
            </select>
            {error && <p className="mt-1 text-label-sm text-critical">{error}</p>}
        </div>
    );
}

// Field errors from a 400 response ({ errors: [{ field, message }] }) keyed by field.
export function fieldErrors(caught: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (caught instanceof ApiError) for (const entry of caught.fieldErrors) out[entry.field] = entry.message;
    return out;
}

// Confirms an ACTIVE / INACTIVE change. The server's refusal (for example "has PROCESSING jobs") is shown as the dialog error.
export function StatusDialog({ title, summary, target, onConfirm, onClose }: {
    title: string; summary: ReactNode; target: EntityStatus; onConfirm: () => Promise<void>; onClose: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await onConfirm();
        } catch (caught) {
            setError(errorMessage(caught));
            setBusy(false);
        }
    };
    return (
        <ActionDialog title={title} busy={busy} onClose={onClose}>
            <form onSubmit={submit}>
                <p className="text-body-sm text-ink-soft">{summary}</p>
                <DialogError message={error} />
                <div className="mt-4 flex justify-end gap-2">
                    <button type="button" disabled={busy} onClick={onClose} className={secondaryButton}>Cancel</button>
                    <button type="submit" disabled={busy} className={target === "INACTIVE" ? dangerSolidButton : primaryButton}>
                        {busy ? "Saving…" : target === "INACTIVE" ? "Make inactive" : "Activate"}
                    </button>
                </div>
            </form>
        </ActionDialog>
    );
}

export function RestrictedPage({ what }: { what: string }) {
    return (
        <div className="mx-auto max-w-4xl p-6">
            <div role="alert" className="rounded border border-critical-border bg-critical-bg p-6 text-center text-critical">
                <h1 className="text-headline-sm font-semibold">Access Restricted</h1>
                <p className="mt-1 text-body-sm text-ink-muted">Your role cannot manage {what}.</p>
            </div>
        </div>
    );
}
