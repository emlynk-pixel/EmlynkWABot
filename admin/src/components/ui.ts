// Shared styles: one look for inputs, labels and
// tables everywhere. Buttons stay in Dialog.tsx (primaryButton and the rest),
// which the Candidates screens also use unchanged.

// Text inputs and selects. `invalid` switches to the error state used with
// FormField (red border + red focus ring). `padding` replaces the default
// horizontal padding (e.g. "pl-9 pr-3" for an input with a leading icon).
export function inputClass(invalid = false, { padding = "px-3", extra = "" }: { padding?: string; extra?: string } = {}): string {
    const state = invalid
        ? "border-critical focus:border-critical focus:shadow-invalid"
        : "border-border-strong hover:border-border-focus focus:border-border-focus focus:shadow-focus";
    return `h-8 w-full rounded-lg border bg-surface ${padding} text-body-lg text-ink md:text-body-sm placeholder:text-ink-subtle focus:outline-none disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-muted ${state} ${extra}`.trim();
}

export function textareaClass(invalid = false, extra = "mt-1"): string {
    return inputClass(invalid, { extra }).replace("h-8 ", "py-2 ");
}

// Filter bars: the same control, sized to sit in a row.
export const filterControl = inputClass();

export const fieldLabel = "text-label-md text-ink";

// Tables: a sentence-case header row and a hairline between rows.
export const tableHead = "h-10 whitespace-nowrap border-b border-border px-4 text-left text-label-md text-ink";
export const tableCellWrap = "h-10 border-b border-border px-4 py-2 text-body-sm";
export const tableCell = "h-10 whitespace-nowrap border-b border-border px-4 text-body-sm";
export const tableRow = "transition-colors hover:bg-canvas";
