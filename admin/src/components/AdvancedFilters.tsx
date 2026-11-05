import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
    ALLOCATION_CHOICES,
    DATE_FILTERS,
    TEXT_FILTERS,
    TEXT_MATCH_LABELS,
    availableFilterFields,
    cleanFilters,
    filterChips,
    listChoices,
    listOf,
    type CandidateFilterOptions,
    type CandidateFilters,
    type FilterField,
    type FilterKey,
    type ListFilterKey,
    type TextFilterKey,
    type TextMatch,
} from "../api/candidateFilters";
import { DatePicker } from "./DatePicker";
import { secondaryButton } from "./dialogParts";
import { Icon } from "./Icon";

// Filters for a candidate list (Admin > Candidates, Work Allocation), in two steps:
//   1. The Filters button opens a small box listing the filters that can be added; ticking one puts
//      it on the page, unticking removes it (and clears its value).
//   2. Each added filter is a button under the search bar; it opens a dropdown with just that filter's
//      control. A change applies at once (text: after a short pause, or Enter), there is no Apply.
// The values are the page's (its URL), passed in as `value`; `onChange` replaces all of them. Which
// filters are added is only what is on screen: a filter that has a value is always shown, so a reload
// or a shared link restores it. The server applies every filter before paging.

const control = "h-8 w-full min-w-0 rounded-lg border border-border-strong bg-surface px-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none";
const labelText = "block text-label-sm text-ink-muted";
const popoverClass = "absolute left-0 top-full z-30 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-surface p-3 shadow-modal";
const TEXT_DEBOUNCE_MS = 500;

type FieldsInput = {
    value: CandidateFilters;
    options: CandidateFilterOptions | null;
    // Filters this list does not take (Work Allocation: the view is the allocation).
    hidden?: readonly FilterKey[];
    onChange: (filters: CandidateFilters) => void;
};

// The fields on screen: the ones the user added (in that order), then any other with a value.
export function useFilterFields({ value, options, hidden, onChange }: FieldsInput) {
    const [picked, setPicked] = useState<string[]>([]);
    const fields = availableFilterFields(options, hidden);
    const clean = cleanFilters(value);
    const hasValue = (field: FilterField) => field.keys.some((key) => clean[key]);
    const active = [
        ...picked.flatMap((id) => fields.filter((field) => field.id === id)),
        ...fields.filter((field) => !picked.includes(field.id) && hasValue(field)),
    ];
    const clear = (field: FilterField) => {
        const next = { ...clean };
        for (const key of field.keys) delete next[key];
        onChange(next);
    };
    return {
        fields,
        active,
        // Filters with a value (what the Filters button counts).
        count: filterChips(value, options).length,
        toggle: (field: FilterField) => {
            if (active.some((entry) => entry.id === field.id)) {
                setPicked((ids) => ids.filter((id) => id !== field.id));
                if (hasValue(field)) clear(field);
            } else setPicked((ids) => [...ids, field.id]);
        },
        remove: (field: FilterField) => {
            setPicked((ids) => ids.filter((id) => id !== field.id));
            if (hasValue(field)) clear(field);
        },
        clearAll: () => {
            setPicked([]);
            onChange({});
        },
    };
}
export type FilterFields = ReturnType<typeof useFilterFields>;

// Closes a popover on Escape (it keeps focus on its button) and on a click outside it. The date
// picker's calendar is drawn outside the popover, so a click in it is not "outside".
function useDismiss(open: boolean, onClose: () => void, ref: { current: HTMLElement | null }) {
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        if (!open) return;
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (event.key === "Escape" && !(event.target as HTMLElement | null)?.closest?.(".date-picker-popover")) closeRef.current();
        };
        const onPointer = (event: PointerEvent) => {
            const target = event.target as Node;
            if (ref.current?.contains(target) || (target as HTMLElement).closest?.(".date-picker-popover, .date-picker-backdrop")) return;
            closeRef.current();
        };
        window.addEventListener("keydown", onKey);
        document.addEventListener("pointerdown", onPointer);
        return () => {
            window.removeEventListener("keydown", onKey);
            document.removeEventListener("pointerdown", onPointer);
        };
    }, [open, ref]);
}

// The Filters button: opens the box of filters that can be added.
export function FiltersButton({ filters }: { filters: FilterFields }) {
    const [open, setOpen] = useState(false);
    const wrapper = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const panelId = useId();
    useDismiss(open, () => {
        setOpen(false);
        button.current?.focus();
    }, wrapper);
    const { count } = filters;
    const offered = filters.fields.filter((field) => field.pickable);
    const groups = [...new Set(offered.map((field) => field.group))];
    return (
        <div ref={wrapper} className="relative shrink-0">
            <button
                ref={button}
                type="button"
                onClick={() => setOpen((was) => !was)}
                aria-haspopup="true"
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                aria-label={count ? `Filters (${count} active)` : "Filters"}
                className={`${secondaryButton} inline-flex shrink-0 items-center gap-1.5 ${count ? "border-primary text-primary" : ""}`}
            >
                <Icon name="filter" className="size-4" />
                Filters
                {count > 0 && <span aria-hidden="true" className="rounded-full bg-primary px-1.5 text-label-sm tabular-nums text-on-primary">{count}</span>}
            </button>
            {open && (
                <div id={panelId} role="group" aria-label="Add filters" className={`${popoverClass} w-[min(20rem,calc(100vw-2rem))] space-y-3`}>
                    <p className="text-label-sm text-ink-muted">Choose the filters to use. Each one appears under the search bar.</p>
                    {groups.map((group) => (
                        <fieldset key={group} className="min-w-0">
                            <legend className="mb-1 text-label-md text-ink">{group}</legend>
                            <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
                                {offered.filter((field) => field.group === group).map((field) => (
                                    <label key={field.id} className="flex items-center gap-2 py-0.5 text-body-sm text-ink">
                                        <input type="checkbox" checked={filters.active.some((entry) => entry.id === field.id)} onChange={() => filters.toggle(field)} className="size-4 shrink-0 accent-primary" />
                                        <span className="min-w-0 break-words">{field.label}</span>
                                    </label>
                                ))}
                            </div>
                        </fieldset>
                    ))}
                </div>
            )}
        </div>
    );
}

// The added filters, under the search bar: a dropdown button each, and Clear all.
export function FilterBar({ filters, value, options, onChange, idPrefix }: {
    filters: FilterFields;
    value: CandidateFilters;
    options: CandidateFilterOptions | null;
    onChange: (filters: CandidateFilters) => void;
    idPrefix: string;
}) {
    if (!filters.active.length) return null;
    const chips = filterChips(value, options);
    return (
        <div role="group" aria-label="Active filters" className="flex flex-wrap items-center gap-2">
            {filters.active.map((field) => (
                <FilterDropdown
                    key={field.id}
                    field={field}
                    chip={chips.find((chip) => chip.id === field.id)?.label ?? null}
                    value={value}
                    options={options}
                    onChange={onChange}
                    onRemove={() => filters.remove(field)}
                    idPrefix={idPrefix}
                />
            ))}
            <button type="button" onClick={filters.clearAll} className="text-label-md text-primary hover:underline">Clear all filters</button>
        </div>
    );
}

function FilterDropdown({ field, chip, value, options, onChange, onRemove, idPrefix }: {
    field: FilterField;
    // The filter's value as text ("Job type: Welder"), or null while it has none.
    chip: string | null;
    value: CandidateFilters;
    options: CandidateFilterOptions | null;
    onChange: (filters: CandidateFilters) => void;
    onRemove: () => void;
    idPrefix: string;
}) {
    const [open, setOpen] = useState(false);
    const wrapper = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const panelId = useId();
    useDismiss(open, () => {
        setOpen(false);
        button.current?.focus();
    }, wrapper);
    const label = chip ?? field.label;
    // The newest value, so a late (debounced) change never overwrites another one.
    const latest = useRef(value);
    latest.current = value;
    const set = (changes: CandidateFilters) => onChange({ ...cleanFilters(latest.current), ...changes });
    return (
        <div ref={wrapper} className="relative max-w-full">
            <span className={`inline-flex max-w-full items-center rounded-lg border text-label-md ${chip ? "border-primary bg-primary-soft text-ink" : "border-border-strong bg-surface text-ink-soft"}`}>
                <button
                    ref={button}
                    type="button"
                    onClick={() => setOpen((was) => !was)}
                    aria-haspopup="true"
                    aria-expanded={open}
                    aria-controls={open ? panelId : undefined}
                    title={label}
                    className="inline-flex h-7 min-w-0 items-center gap-1 rounded-l-lg pl-2 pr-1 hover:bg-canvas/50"
                >
                    <span className="max-w-[16rem] truncate">{label}</span>
                    <Icon name="keyboard_arrow_down" className="size-3.5 shrink-0" />
                </button>
                <button type="button" onClick={onRemove} aria-label={`Remove filter: ${label}`} className="h-7 rounded-r-lg px-1.5 text-ink-muted hover:bg-canvas/50 hover:text-ink">
                    <Icon name="close" className="size-3.5" />
                </button>
            </span>
            {open && (
                <div id={panelId} role="group" aria-label={field.label} className={`${popoverClass} w-[min(20rem,calc(100vw-2rem))]`}>
                    {field.kind === "list" && <ListControl field={field} options={options} value={value} set={set} />}
                    {field.kind === "text" && <TextControl field={field} value={value} set={set} id={`${idPrefix}-${field.id}`} />}
                    {field.kind === "date" && <DateControl field={field} value={value} set={set} idPrefix={idPrefix} />}
                    {field.kind === "allocation" && (
                        <label className={labelText}>
                            {field.label}
                            <select value={value.allocation ?? ""} onChange={(event) => set({ allocation: event.target.value })} className={`${control} mt-1`}>
                                <option value="">Allocated or not</option>
                                {ALLOCATION_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                            </select>
                        </label>
                    )}
                </div>
            )}
        </div>
    );
}

type ControlProps = { field: FilterField; value: CandidateFilters; set: (changes: CandidateFilters) => void };

// Any of the ticked values (IN). Native checkboxes: keyboard operable as they are.
function ListControl({ field, options, value, set }: ControlProps & { options: CandidateFilterOptions | null }) {
    const key = field.id as ListFilterKey;
    const selected = listOf(value[key]);
    const choices = listChoices(key, options);
    // A value no longer offered (an inactive job type in the URL) stays visible, so it can be removed.
    const all = [...choices, ...selected.filter((entry) => !choices.some((choice) => choice.value === entry)).map((entry) => ({ value: entry, label: entry }))];
    const toggle = (entry: string) => set({ [key]: (selected.includes(entry) ? selected.filter((v) => v !== entry) : [...selected, entry]).join(",") });
    return (
        <div>
            {all.length === 0 && <p className="py-1 text-label-sm text-ink-subtle">No choices available.</p>}
            {all.map((choice) => (
                <label key={choice.value} className="flex items-center gap-2 py-0.5 text-body-sm text-ink">
                    <input type="checkbox" checked={selected.includes(choice.value)} onChange={() => toggle(choice.value)} className="size-4 shrink-0 accent-primary" />
                    <span className="min-w-0 break-words">{choice.label}</span>
                </label>
            ))}
        </div>
    );
}

// A text and how to match it. The text applies after a short pause in typing, or on Enter; the match
// type applies at once when there is text (before that it is only remembered here).
function TextControl({ field, value, set, id }: ControlProps & { id: string }) {
    const key = field.id as TextFilterKey;
    const spec = TEXT_FILTERS.find((entry) => entry.key === key)!;
    const saved = value[key] ?? "";
    const savedMatch = (value[`${key}Match`] ?? "contains") as TextMatch;
    const [text, setText] = useState(saved);
    const [match, setMatch] = useState<TextMatch>(savedMatch);
    useEffect(() => setText(saved), [saved]);
    useEffect(() => setMatch(savedMatch), [savedMatch]);
    const setRef = useRef(set);
    setRef.current = set;
    const apply = (nextText: string, nextMatch: TextMatch) => setRef.current({ [key]: nextText.trim(), [`${key}Match`]: nextMatch });
    useEffect(() => {
        if (text.trim() === saved) return;
        const timer = setTimeout(() => apply(text, match), TEXT_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [text, saved]);
    const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        apply(text, match);
    };
    return (
        <div>
            <label htmlFor={id} className={`${labelText} mb-1`}>{field.label}</label>
            <div className="flex gap-2">
                {spec.matches.length > 1 && (
                    <select
                        aria-label={`${field.label} match`}
                        value={match}
                        onChange={(event) => {
                            const chosen = event.target.value as TextMatch;
                            setMatch(chosen);
                            if (text.trim()) apply(text, chosen);
                        }}
                        className={`${control.replace("w-full", "w-32")} shrink-0`}
                    >
                        {spec.matches.map((entry) => <option key={entry} value={entry}>{TEXT_MATCH_LABELS[entry]}</option>)}
                    </select>
                )}
                <input id={id} type="text" autoFocus value={text} maxLength={100} onChange={(event) => setText(event.target.value)} onKeyDown={onEnter} className={control} />
            </div>
        </div>
    );
}

// A date range, inclusive, Sri Lanka days (the server's rule); each valid date applies at once.
function DateControl({ field, value, set, idPrefix }: ControlProps & { idPrefix: string }) {
    const range = DATE_FILTERS.find((entry) => entry.from === field.id)!;
    const from = value[range.from] ?? "";
    const to = value[range.to] ?? "";
    const id = (key: string) => `${idPrefix}-${key}`;
    const part = (label: string, children: ReactNode, htmlFor: string) => (
        <div className="min-w-0">
            <label className={`${labelText} mb-1`} htmlFor={htmlFor}>{label}</label>
            {children}
        </div>
    );
    return (
        <div className="grid grid-cols-1 gap-3">
            {part("From", <DatePicker id={id(range.from)} value={from} max={to || undefined} clearable onChange={(date) => set({ [range.from]: date })} className={control} />, id(range.from))}
            {part("To", <DatePicker id={id(range.to)} value={to} min={from || undefined} clearable onChange={(date) => set({ [range.to]: date })} className={control} />, id(range.to))}
        </div>
    );
}
