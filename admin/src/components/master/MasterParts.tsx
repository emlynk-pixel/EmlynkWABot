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

// Horizontal page tabs (Client details, Agent details), in the Settings / Job details style.
// The tab is page state: tab `${idPrefix}-tab-${key}` controls panel `${idPrefix}-panel-${key}`.
export function PageTabs<K extends string>({ label, idPrefix, tabs, value, onChange }: { label: string; idPrefix: string; tabs: { key: K; label: string }[]; value: K; onChange: (key: K) => void }) {
    return (
        <div role="tablist" aria-label={label} className="flex gap-6 overflow-x-auto border-b border-border">
            {tabs.map((tab) => (
                <button
                    key={tab.key} type="button" role="tab" id={`${idPrefix}-tab-${tab.key}`} aria-controls={`${idPrefix}-panel-${tab.key}`} aria-selected={value === tab.key}
                    onClick={() => onChange(tab.key)}
                    className={`-mb-px whitespace-nowrap border-b-2 px-1 pb-2.5 pt-1 text-label-md transition-colors ${value === tab.key ? "border-primary font-medium text-ink" : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink"}`}
                >
                    {tab.label}
                </button>
            ))}
        </div>
    );
}

export type MultiOption = { id: string; label: string; hint?: string; disabled?: boolean };

// Several related records (an Agent's Clients, a Client's Agents): a searchable checkbox list
// with the selection shown as removable chips. Each id is selected at most once; a disabled
// option (e.g. an inactive agent) cannot be added, but if it is already selected it stays
// shown and can be removed. The server re-checks every id.
export function MultiSelect({ label, options, selected, onChange, disabled, error, required, hint, empty }: {
    label: string; options: MultiOption[]; selected: string[]; onChange: (ids: string[]) => void; disabled: boolean;
    error?: string; required?: boolean; hint?: string; empty: string;
}) {
    const id = useId();
    const [search, setSearch] = useState("");
    const chosen = new Set(selected);
    const term = search.trim().toLowerCase();
    const shown = options.filter((option) => !term || option.label.toLowerCase().includes(term) || option.hint?.toLowerCase().includes(term));
    const toggle = (optionId: string) => onChange(chosen.has(optionId) ? selected.filter((x) => x !== optionId) : [...selected, optionId]);
    const labelOf = (optionId: string) => options.find((option) => option.id === optionId)?.label ?? optionId;
    return (
        <fieldset aria-describedby={hint || error ? `${id}-note` : undefined}>
            <legend className="text-label-md text-ink">{label}{required ? " *" : <span className="text-ink-muted"> (optional)</span>}</legend>
            {selected.length > 0 && (
                <ul aria-label={`Selected ${label.toLowerCase()}`} className="mt-1 flex flex-wrap gap-1.5">
                    {selected.map((optionId) => (
                        <li key={optionId} className="inline-flex items-center gap-1 rounded-full border border-border bg-canvas py-0.5 pl-2.5 pr-1 text-label-sm text-ink">
                            {labelOf(optionId)}
                            <button type="button" disabled={disabled} onClick={() => toggle(optionId)} aria-label={`Remove ${labelOf(optionId)}`} className="rounded-full px-1 text-ink-muted hover:text-critical">×</button>
                        </li>
                    ))}
                </ul>
            )}
            {options.length > 6 && (
                <input type="search" aria-label={`Search ${label.toLowerCase()}`} value={search} disabled={disabled} placeholder="Search…" onChange={(event) => setSearch(event.target.value)} className={`${inputClass()} mt-2`} />
            )}
            {options.length === 0 ? (
                <p className="mt-1 text-body-sm text-ink-muted">{empty}</p>
            ) : (
                <ul aria-label={label} className={`mt-2 max-h-48 divide-y divide-border overflow-y-auto rounded border ${error ? "border-critical" : "border-border"}`}>
                    {shown.map((option) => {
                        const boxId = `${id}-${option.id}`;
                        const isChosen = chosen.has(option.id);
                        return (
                            <li key={option.id} className="flex items-center gap-2 px-3 py-1.5">
                                <input id={boxId} type="checkbox" checked={isChosen} disabled={disabled || (option.disabled && !isChosen)} onChange={() => toggle(option.id)} className="size-4 shrink-0 accent-primary" />
                                <label htmlFor={boxId} className="min-w-0 flex-1 cursor-pointer text-body-sm text-ink">
                                    {option.label}{option.hint && <span className="ml-1 text-label-sm text-ink-muted">{option.hint}</span>}
                                </label>
                            </li>
                        );
                    })}
                    {shown.length === 0 && <li className="px-3 py-2 text-body-sm text-ink-muted">No match.</li>}
                </ul>
            )}
            {error ? <p id={`${id}-note`} className="mt-1 text-label-sm text-critical">{error}</p> : hint && <p id={`${id}-note`} className="mt-1 text-label-sm text-ink-muted">{hint}</p>}
        </fieldset>
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
