import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
    ALLOCATION_CHOICES,
    DATE_FILTERS,
    LIST_LABELS,
    TEXT_FILTERS,
    TEXT_MATCH_LABELS,
    cleanFilters,
    filterChips,
    listChoices,
    listOf,
    type CandidateFilterOptions,
    type CandidateFilters,
    type FilterKey,
    type ListFilterKey,
    type TextFilterKey,
    type TextMatch,
} from "../api/candidateFilters";
import { DatePicker } from "./DatePicker";
import { primaryButton, secondaryButton } from "./dialogParts";
import { Icon } from "./Icon";

// Advanced filters for a candidate list (Admin > Candidates, Work Allocation): a button that opens
// a dialog where any number of filters are set together, then applied with ONE request (Apply
// filters). The applied filters are the page's (its URL), passed in as `value`; the dialog edits a
// copy, so closing it without applying changes nothing. The server applies them before paging.

const control = "h-8 w-full min-w-0 rounded-lg border border-border-strong bg-surface px-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none";
const labelText = "block text-label-sm text-ink-muted";

type Visibility = {
    // Filters this list does not take (Work Allocation: the view is the allocation).
    hidden?: readonly FilterKey[];
};

// Which filters the user can use here: officers only with the officer choices (ADMIN / TEAM_LEAD),
// clients and agents only with theirs (the server refuses the others for the role anyway).
function visibleKeys(options: CandidateFilterOptions | null, hidden: readonly FilterKey[] = []) {
    const shown = (key: FilterKey) => !hidden.includes(key);
    return {
        shown,
        officer: shown("analystId") && Boolean(options?.officers),
        allocation: shown("allocation") && Boolean(options?.officers),
        client: shown("clientId") && Boolean(options?.clients),
        agent: shown("agentId") && Boolean(options?.agents),
    };
}

export function AdvancedFiltersButton({ value, options, onApply, hidden, idPrefix }: Visibility & {
    value: CandidateFilters;
    options: CandidateFilterOptions | null;
    onApply: (filters: CandidateFilters) => void;
    idPrefix: string;
}) {
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const count = filterChips(value, options).length;
    const close = () => {
        setOpen(false);
        buttonRef.current?.focus();
    };
    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                onClick={() => setOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={count ? `Advanced filters (${count} active)` : "Advanced filters"}
                className={`${secondaryButton} inline-flex shrink-0 items-center gap-1.5 ${count ? "border-primary text-primary" : ""}`}
            >
                <Icon name="filter" className="size-4" />
                Advanced filters
                {count > 0 && <span aria-hidden="true" className="rounded-full bg-primary px-1.5 text-label-sm tabular-nums text-on-primary">{count}</span>}
            </button>
            {open && (
                <AdvancedFiltersDialog
                    value={value}
                    options={options}
                    hidden={hidden}
                    idPrefix={idPrefix}
                    onClose={close}
                    onApply={(filters) => {
                        onApply(filters);
                        close();
                    }}
                />
            )}
        </>
    );
}

function AdvancedFiltersDialog({ value, options, hidden, idPrefix, onClose, onApply }: Visibility & {
    value: CandidateFilters;
    options: CandidateFilterOptions | null;
    idPrefix: string;
    onClose: () => void;
    onApply: (filters: CandidateFilters) => void;
}) {
    const titleId = useId();
    const dialogRef = useRef<HTMLDivElement>(null);
    const [draft, setDraft] = useState<CandidateFilters>(() => ({ ...value }));
    const set = (key: FilterKey, next: string) => setDraft((previous) => ({ ...previous, [key]: next }));
    const visible = visibleKeys(options, hidden);
    const id = (key: string) => `${idPrefix}-${key}`;

    // Focus the first field once, on open. Escape closes without applying (the date picker's own
    // Escape closes only its calendar).
    useEffect(() => {
        dialogRef.current?.querySelector<HTMLElement>("input, select")?.focus();
    }, []);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (event.key === "Escape") closeRef.current();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    // Tab stays inside the dialog.
    const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Tab" || !dialogRef.current) return;
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        onApply(cleanFilters(draft));
    };
    const text = (key: TextFilterKey) => {
        const field = TEXT_FILTERS.find((entry) => entry.key === key)!;
        return <TextFilter key={key} id={id(key)} label={field.label} matches={field.matches} value={draft[key] ?? ""} match={(draft[`${key}Match`] ?? "contains") as TextMatch} onValue={(next) => set(key, next)} onMatch={(next) => set(`${key}Match`, next)} />;
    };
    const list = (key: ListFilterKey) => (
        <MultiSelect key={key} id={id(key)} label={LIST_LABELS[key]} choices={listChoices(key, options)} value={listOf(draft[key])} onChange={(values) => set(key, values.join(","))} />
    );

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-xs">
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trapFocus} className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-surface shadow-modal">
                <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
                    <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
                        <div>
                            <h2 id={titleId} className="text-headline-sm text-ink">Advanced filters</h2>
                            <p className="text-label-sm text-ink-muted">A candidate must match every filter you set.</p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close advanced filters" className="rounded-lg p-1 text-ink-muted hover:bg-canvas hover:text-ink">
                            <Icon name="close" className="size-5" />
                        </button>
                    </div>
                    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
                        <Section title="Identity">
                            {(["name", "surname", "otherNames", "passport", "nic", "whatsapp"] as const).map(text)}
                        </Section>
                        <Section title="Candidate">
                            {list("jobType")}
                            {list("workflowStatus")}
                            {list("stage")}
                            {list("sex")}
                            {text("nationality")}
                            {DATE_FILTERS.map((range) => (
                                <fieldset key={range.from} className="min-w-0">
                                    <legend className={labelText}>{range.label}</legend>
                                    <div className="mt-1 grid grid-cols-2 gap-2">
                                        <label className={labelText} htmlFor={id(range.from)}>
                                            From
                                            <DatePicker id={id(range.from)} value={draft[range.from] ?? ""} max={draft[range.to] || undefined} clearable onChange={(date) => set(range.from, date)} className={`${control} mt-1`} />
                                        </label>
                                        <label className={labelText} htmlFor={id(range.to)}>
                                            To
                                            <DatePicker id={id(range.to)} value={draft[range.to] ?? ""} min={draft[range.from] || undefined} clearable onChange={(date) => set(range.to, date)} className={`${control} mt-1`} />
                                        </label>
                                    </div>
                                </fieldset>
                            ))}
                        </Section>
                        {(visible.officer || visible.allocation) && (
                            <Section title="Allocation">
                                {visible.allocation && (
                                    <label className={labelText}>
                                        Allocation
                                        <select value={draft.allocation ?? ""} onChange={(event) => set("allocation", event.target.value)} className={`${control} mt-1`}>
                                            <option value="">Allocated or not</option>
                                            {ALLOCATION_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                                        </select>
                                    </label>
                                )}
                                {visible.officer && list("analystId")}
                            </Section>
                        )}
                        <Section title="Current job">
                            {text("jobCode")}
                            {visible.client && list("clientId")}
                            {visible.agent && list("agentId")}
                        </Section>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
                        <button type="button" onClick={() => onApply({})} className={secondaryButton}>Clear all</button>
                        <div className="flex gap-2">
                            <button type="button" onClick={onClose} className={secondaryButton}>Cancel</button>
                            <button type="submit" className={primaryButton}>Apply filters</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section aria-label={title}>
            <h3 className="mb-2 text-label-md text-ink">{title}</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
        </section>
    );
}

function TextFilter({ id, label, matches, value, match, onValue, onMatch }: {
    id: string;
    label: string;
    matches: readonly TextMatch[];
    value: string;
    match: TextMatch;
    onValue: (value: string) => void;
    onMatch: (match: TextMatch) => void;
}) {
    return (
        <div className="min-w-0">
            <label htmlFor={id} className={labelText}>{label}</label>
            <div className="mt-1 flex gap-2">
                {matches.length > 1 && (
                    <select aria-label={`${label} match`} value={match} onChange={(event) => onMatch(event.target.value as TextMatch)} className={`${control} w-32 shrink-0`}>
                        {matches.map((entry) => <option key={entry} value={entry}>{TEXT_MATCH_LABELS[entry]}</option>)}
                    </select>
                )}
                <input id={id} type="text" value={value} maxLength={100} onChange={(event) => onValue(event.target.value)} className={control} />
            </div>
        </div>
    );
}

// Any of the ticked values (IN). Native checkboxes: keyboard operable as they are.
function MultiSelect({ id, label, choices, value, onChange }: { id: string; label: string; choices: { value: string; label: string }[]; value: string[]; onChange: (values: string[]) => void }) {
    // A value no longer offered (an inactive job type in the URL) stays visible, so it can be removed.
    const all = [...choices, ...value.filter((entry) => !choices.some((choice) => choice.value === entry)).map((entry) => ({ value: entry, label: entry }))];
    const toggle = (entry: string) => onChange(value.includes(entry) ? value.filter((v) => v !== entry) : [...value, entry]);
    return (
        <fieldset className="min-w-0">
            <legend className={labelText}>
                {label}
                {value.length > 0 && <span className="ml-1 text-primary">({value.length} selected)</span>}
            </legend>
            <div id={id} className="mt-1 max-h-36 overflow-y-auto rounded-lg border border-border-strong bg-surface px-2 py-1">
                {all.length === 0 && <p className="py-1 text-label-sm text-ink-subtle">No choices available.</p>}
                {all.map((choice) => (
                    <label key={choice.value} className="flex items-center gap-2 py-0.5 text-body-sm text-ink">
                        <input type="checkbox" checked={value.includes(choice.value)} onChange={() => toggle(choice.value)} className="size-4 shrink-0 accent-primary" />
                        <span className="min-w-0 break-words">{choice.label}</span>
                    </label>
                ))}
            </div>
        </fieldset>
    );
}

// The applied filters as chips: each removes only its own filter; Clear all removes them all.
export function ActiveFilterChips({ value, options, onChange }: { value: CandidateFilters; options: CandidateFilterOptions | null; onChange: (filters: CandidateFilters) => void }) {
    const chips = filterChips(value, options);
    if (!chips.length) return null;
    const remove = (keys: FilterKey[]) => {
        const next = { ...cleanFilters(value) };
        for (const key of keys) delete next[key];
        onChange(next);
    };
    return (
        <div role="group" aria-label="Active filters" className="flex flex-wrap items-center gap-1.5">
            {chips.map((chip) => (
                <span key={chip.id} className="inline-flex max-w-full items-center gap-1 rounded-lg bg-primary-soft py-0.5 pl-2 pr-1 text-label-sm text-ink">
                    <span className="min-w-0 break-words">{chip.label}</span>
                    <button type="button" onClick={() => remove(chip.keys)} aria-label={`Remove filter: ${chip.label}`} className="rounded p-0.5 text-ink-muted hover:bg-surface hover:text-ink">
                        <Icon name="close" className="size-3.5" />
                    </button>
                </span>
            ))}
            <button type="button" onClick={() => onChange({})} className="text-label-md text-primary hover:underline">Clear all filters</button>
        </div>
    );
}
