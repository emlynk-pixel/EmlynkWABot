import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";

// Admin version of the date picker (the Candidate Form has its own, with its translations, in
// candidate-form/src/components/DatePicker.tsx). A date field with a calendar. The value is ALWAYS a date-only string,
// "YYYY-MM-DD" (or "" for none): never a locale string, a timestamp or a
// time-zone shifted ISO date. The calendar works on local calendar days built
// from the year / month / day numbers, so no day can shift.
//
// Typing is supported in ONE format only, YYYY-MM-DD (no DD/MM or MM/DD
// guessing). A real date is passed on as soon as it is complete (the page's
// own rules, e.g. "not in the future", then judge it); anything else is not
// accepted and is cleared when the field loses focus, with a message. The
// calendar opens from the field or the calendar button, offers month and year
// lists (so a birth date is a few taps, not hundreds of clicks), and keeps
// disabled days outside min / max unselectable.

export type DatePickerLabels = {
    openCalendar: string;
    calendar: string;
    previousMonth: string;
    nextMonth: string;
    month: string;
    year: string;
    today: string;
    clear: string;
    close: string;
    selected: string;
    invalidFormat: string;
};

export const ADMIN_DATE_LABELS: DatePickerLabels = {
    openCalendar: "Open calendar",
    calendar: "Choose a date",
    previousMonth: "Previous month",
    nextMonth: "Next month",
    month: "Month",
    year: "Year",
    today: "Today",
    clear: "Clear",
    close: "Close",
    selected: "selected",
    invalidFormat: "Enter the date as YYYY-MM-DD, or choose it from the calendar.",
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export const DEFAULT_MIN = "1900-01-01";
export const DEFAULT_MAX = "2100-12-31";

// "YYYY-MM-DD" -> a local calendar day, or undefined when it is not a real date.
export function parseDay(value: string): Date | undefined {
    const match = DATE_PATTERN.exec(value);
    if (!match) return undefined;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : undefined;
}

// A local calendar day -> "YYYY-MM-DD" from its own year / month / day (never toISOString, which shifts by time zone).
export function formatDay(date: Date): string {
    return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const clampDay = (date: Date, min: Date, max: Date) => (date < min ? min : date > max ? max : date);
const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short" });
const monthName = new Intl.DateTimeFormat("en-GB", { month: "long" });

const SHEET_BELOW_PX = 520;
const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT = 400;

type Placement = { sheet: boolean; style: CSSProperties };

// Margin classes of the field (e.g. "mt-1") belong to the whole control, the rest to the text box.
const splitClasses = (className = "") => {
    const parts = className.split(/\s+/).filter(Boolean);
    return { outer: parts.filter((part) => /^m[tblrxy]?-/.test(part)).join(" "), control: parts.filter((part) => !/^m[tblrxy]?-/.test(part)).join(" ") };
};

export function DatePicker({ id, value, onChange, min = DEFAULT_MIN, max = DEFAULT_MAX, disabled, required, invalid, describedBy, clearable, className, ariaLabel, labels = ADMIN_DATE_LABELS }: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    min?: string;
    max?: string;
    disabled?: boolean;
    required?: boolean;
    invalid?: boolean;
    describedBy?: string;
    // Offer Clear in the calendar. Default: only when the field is optional.
    clearable?: boolean;
    // Classes of the text box (as the other text fields of the page).
    className?: string;
    // For a field with no visible label element.
    ariaLabel?: string;
    labels?: DatePickerLabels;
}) {
    const popoverId = useId();
    const typedErrorId = useId();
    const wrapper = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const popover = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(value);
    const [typedError, setTypedError] = useState(false);
    const { outer, control } = splitClasses(className);
    const [placement, setPlacement] = useState<Placement | null>(null);

    const minDay = parseDay(min) ?? new Date(1900, 0, 1);
    const maxDay = parseDay(max) ?? new Date(2100, 11, 31);
    const selected = parseDay(value);
    const canClear = (clearable ?? !required) && value !== "";
    const [month, setMonth] = useState<Date>(() => clampDay(selected ?? new Date(), minDay, maxDay));

    // The page owns the value: follow it (a typed draft is replaced once the value changes).
    useEffect(() => {
        setDraft(value);
        if (value) setTypedError(false);
    }, [value]);

    const close = useCallback((returnFocus: boolean) => {
        setOpen(false);
        if (returnFocus) input.current?.focus();
    }, []);

    const openCalendar = () => {
        if (disabled) return;
        setMonth(clampDay(parseDay(value) ?? new Date(), minDay, maxDay));
        setOpen(true);
    };

    // Position: a bottom sheet on narrow screens, otherwise under (or over) the field, kept inside the viewport.
    const place = useCallback(() => {
        const box = wrapper.current?.getBoundingClientRect();
        if (!box) return;
        const viewportWidth = window.innerWidth;
        if (viewportWidth <= SHEET_BELOW_PX) {
            setPlacement({ sheet: true, style: {} });
            return;
        }
        const left = Math.max(8, Math.min(box.left, viewportWidth - POPOVER_WIDTH - 8));
        const below = window.innerHeight - box.bottom;
        const top = below >= POPOVER_HEIGHT || box.top < POPOVER_HEIGHT ? box.bottom + 6 : box.top - POPOVER_HEIGHT - 6;
        setPlacement({ sheet: false, style: { top: Math.max(8, top), left } });
    }, []);
    useLayoutEffect(() => {
        if (!open) return undefined;
        place();
        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);
        return () => {
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
        };
    }, [open, place]);

    // Outside click closes.
    useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event: PointerEvent) => {
            const target = event.target as Node;
            if (popover.current?.contains(target) || wrapper.current?.contains(target)) return;
            close(false);
        };
        document.addEventListener("pointerdown", onPointer);
        return () => document.removeEventListener("pointerdown", onPointer);
    }, [open, close]);

    const pick = (date: Date | undefined) => {
        if (!date) return;
        setTypedError(false);
        onChange(formatDay(date));
        close(true);
    };

    const onType = (raw: string) => {
        setDraft(raw);
        const trimmed = raw.trim();
        if (trimmed === "") {
            setTypedError(false);
            onChange("");
            return;
        }
        if (parseDay(trimmed)) {
            setTypedError(false);
            onChange(trimmed);
        }
    };
    const onBlur = () => {
        const trimmed = draft.trim();
        if (trimmed === "" || parseDay(trimmed)) return;
        // Not a real YYYY-MM-DD date: it is not accepted. The value is cleared, so a required date is reported by the page.
        setTypedError(true);
        onChange("");
    };

    // Escape closes only the calendar (not a dialog around it) and returns focus to the field.
    const onPopoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
            event.stopPropagation();
            event.preventDefault();
            close(true);
        }
    };
    const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowDown" && event.altKey) {
            event.preventDefault();
            openCalendar();
        } else if (event.key === "Escape" && open) {
            event.stopPropagation();
            close(false);
        }
    };

    // Today as a calendar day (midnight), so a field whose last allowed day is today still offers Today.
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayAllowed = today >= minDay && today <= maxDay;
    const describedIds = [describedBy, typedError ? typedErrorId : null].filter(Boolean).join(" ") || undefined;

    return (
        <div className={`date-picker ${outer}`} ref={wrapper}>
            <div className="date-picker-row">
                <input
                    ref={input}
                    id={id}
                    name={id}
                    className={control}
                    aria-label={ariaLabel}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="YYYY-MM-DD"
                    maxLength={10}
                    value={draft}
                    disabled={disabled}
                    required={required}
                    aria-invalid={invalid || typedError ? true : undefined}
                    aria-describedby={describedIds}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-controls={open ? popoverId : undefined}
                    onChange={(event) => onType(event.target.value)}
                    onBlur={onBlur}
                    onKeyDown={onInputKeyDown}
                />
                <button type="button" className="date-picker-button" disabled={disabled} aria-label={labels.openCalendar} aria-expanded={open} aria-controls={open ? popoverId : undefined} onClick={() => (open ? close(false) : openCalendar())}>
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
                        <path fill="currentColor" d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7zm-2 8h14v10H5V10z" />
                    </svg>
                </button>
            </div>
            {typedError && <p id={typedErrorId} className="mt-1 text-label-sm text-critical" role="alert">{labels.invalidFormat}</p>}
            {open && placement && createPortal(
                <>
                    {placement.sheet && <div className="date-picker-backdrop" aria-hidden="true" onPointerDown={() => close(false)} />}
                    <div
                        ref={popover}
                        id={popoverId}
                        role="dialog"
                        aria-label={labels.calendar}
                        className={`date-picker-popover${placement.sheet ? " is-sheet" : ""}`}
                        style={placement.style}
                        onKeyDown={onPopoverKeyDown}
                    >
                        <DayPicker
                            mode="single"
                            autoFocus
                            captionLayout="dropdown"
                            selected={selected}
                            onSelect={pick}
                            month={month}
                            onMonthChange={setMonth}
                            startMonth={new Date(minDay.getFullYear(), minDay.getMonth(), 1)}
                            endMonth={new Date(maxDay.getFullYear(), maxDay.getMonth(), 1)}
                            disabled={[{ before: minDay }, { after: maxDay }]}
                            weekStartsOn={1}
                            showOutsideDays
                            formatters={{
                                formatWeekdayName: (date) => weekday.format(date).slice(0, 2),
                                formatMonthDropdown: (date) => monthName.format(date),
                                formatYearDropdown: (date) => String(date.getFullYear()),
                                formatDay: (date) => String(date.getDate()),
                            }}
                            labels={{
                                labelPrevious: () => labels.previousMonth,
                                labelNext: () => labels.nextMonth,
                                labelMonthDropdown: () => labels.month,
                                labelYearDropdown: () => labels.year,
                                labelDayButton: (date, modifiers) => `${formatDay(date)}${modifiers.selected ? `, ${labels.selected}` : ""}`,
                            }}
                        />
                        <div className="date-picker-footer">
                            {todayAllowed && <button type="button" onClick={() => pick(today)}>{labels.today}</button>}
                            {canClear && <button type="button" onClick={() => { setTypedError(false); onChange(""); close(true); }}>{labels.clear}</button>}
                            <button type="button" onClick={() => close(true)}>{labels.close}</button>
                        </div>
                    </div>
                </>,
                document.body,
            )}
        </div>
    );
}
