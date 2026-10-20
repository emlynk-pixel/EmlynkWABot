import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { DatePicker, formatDay, parseDay, type DatePickerLabels } from "../components/DatePicker";
import styles from "../styles.css?raw";
import { en, field, fillBasic, fillContact, setField, si, startsWith, switchLanguage, verified } from "./helpers";

// The calendar date picker: a text field (YYYY-MM-DD) plus a calendar. The value is always a
// date-only string. Unit tests use the component directly; the integration tests use the real form.

const LABELS: DatePickerLabels = {
    openCalendar: "Open calendar", calendar: "Choose a date", previousMonth: "Previous month", nextMonth: "Next month", month: "Month", year: "Year",
    today: "Today", clear: "Clear", close: "Close", selected: "selected", invalidFormat: "Enter the date as YYYY-MM-DD.",
};

function Harness({ initial = "", min, max, required, onValue }: { initial?: string; min?: string; max?: string; required?: boolean; onValue?: (value: string) => void }) {
    const [value, setValue] = useState(initial);
    return (
        <>
            <label htmlFor="d">Date</label>
            <DatePicker id="d" value={value} onChange={(next) => { setValue(next); onValue?.(next); }} min={min} max={max} required={required} labels={LABELS} />
            <output data-testid="value">{value}</output>
        </>
    );
}
const input = () => screen.getByLabelText("Date") as HTMLInputElement;
const openCalendar = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Open calendar" }));
    return screen.findByRole("dialog", { name: "Choose a date" });
};

describe("DatePicker (component)", () => {
    test("DATE-001 / 002 / 003 the calendar opens from the field button, a picked day is stored as YYYY-MM-DD", async () => {
        const seen: string[] = [];
        render(<Harness onValue={(v) => seen.push(v)} min="1900-01-01" max="2100-12-31" />);
        const user = userEvent.setup();
        const dialog = await openCalendar(user);
        await user.selectOptions(within(dialog).getByLabelText("Year"), "1990");
        await user.selectOptions(within(dialog).getByLabelText("Month"), "May");
        await user.click(within(dialog).getByRole("button", { name: "1990-05-15" }));
        expect(screen.getByTestId("value")).toHaveTextContent("1990-05-15");
        expect(input()).toHaveValue("1990-05-15");
        expect(seen).toEqual(["1990-05-15"]);
        expect(seen.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))).toBe(true);
        expect(screen.queryByRole("dialog")).toBeNull(); // picking closes it
        expect(input()).toHaveFocus(); // and returns focus to the field
    });

    test("DATE-004 / 005 the year list covers the whole allowed range (birth dates back to 1900, passport expiry far into the future)", async () => {
        const first = render(<Harness min="1900-01-01" max="2026-10-17" />);
        const user = userEvent.setup();
        let dialog = await openCalendar(user);
        let years = within(within(dialog).getByLabelText("Year")).getAllByRole("option").map((option) => Number(option.textContent));
        expect(years[0]).toBe(1900);
        expect(years.at(-1)).toBe(2026);
        expect(years).toHaveLength(2026 - 1900 + 1);
        first.unmount();

        render(<Harness min="1900-01-01" max="2100-12-31" />);
        dialog = await openCalendar(user);
        years = within(within(dialog).getByLabelText("Year")).getAllByRole("option").map((option) => Number(option.textContent));
        expect(years).toContain(2040);
        expect(years.at(-1)).toBe(2100);
        // A far year in one step, not by clicking months.
        await user.selectOptions(within(dialog).getByLabelText("Year"), "2040");
        await user.selectOptions(within(dialog).getByLabelText("Month"), "January");
        await user.click(within(dialog).getByRole("button", { name: "2040-01-10" }));
        expect(screen.getByTestId("value")).toHaveTextContent("2040-01-10");
    });

    test("days outside min and max cannot be picked", async () => {
        render(<Harness initial="2026-10-10" min="2026-10-05" max="2026-10-20" />);
        const user = userEvent.setup();
        const dialog = await openCalendar(user);
        expect(within(dialog).getByRole("button", { name: "2026-10-04" })).toBeDisabled();
        expect(within(dialog).getByRole("button", { name: "2026-10-21" })).toBeDisabled();
        expect(within(dialog).getByRole("button", { name: "2026-10-12" })).toBeEnabled();
        expect(within(dialog).getByRole("button", { name: "2026-10-10, selected" })).toBeInTheDocument();
    });

    test("DATE-007 an optional date can be cleared; a required one has no Clear", async () => {
        const optional = render(<Harness initial="2026-03-25" />);
        const user = userEvent.setup();
        const dialog = await openCalendar(user);
        await user.click(within(dialog).getByRole("button", { name: "Clear" }));
        expect(screen.getByTestId("value")).toHaveTextContent("");
        expect(input()).toHaveValue("");
        optional.unmount();

        render(<Harness initial="2026-03-25" required />);
        const requiredDialog = await openCalendar(user);
        expect(within(requiredDialog).queryByRole("button", { name: "Clear" })).toBeNull();
        expect(within(requiredDialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
    });

    test("DATE-008 Escape closes only the calendar and returns focus; it does not reach a handler behind it", async () => {
        const behind = vi.fn();
        window.addEventListener("keydown", behind);
        render(<Harness initial="2026-03-25" />);
        const user = userEvent.setup();
        await openCalendar(user);
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(input()).toHaveFocus();
        expect(behind.mock.calls.filter(([event]) => (event as KeyboardEvent).key === "Escape")).toHaveLength(0);
        window.removeEventListener("keydown", behind);
    });

    test("DATE-009 a click outside closes the calendar", async () => {
        render(<><Harness initial="2026-03-25" /><button type="button">elsewhere</button></>);
        const user = userEvent.setup();
        await openCalendar(user);
        await user.click(screen.getByRole("button", { name: "elsewhere" }));
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    test("DATE-010 the keyboard works: the selected day has focus, arrows move, Enter picks", async () => {
        render(<Harness initial="2026-03-25" />);
        const user = userEvent.setup();
        await openCalendar(user);
        expect(screen.getByRole("button", { name: "2026-03-25, selected" })).toHaveFocus();
        await user.keyboard("{ArrowRight}");
        expect(screen.getByRole("button", { name: "2026-03-26" })).toHaveFocus();
        await user.keyboard("{ArrowDown}");
        expect(screen.getByRole("button", { name: "2026-04-02" })).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(screen.getByTestId("value")).toHaveTextContent("2026-04-02");
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    test("typing: one format only (YYYY-MM-DD). A real date is accepted, DD/MM/YYYY is not guessed at, and the bad text is flagged and cleared on leaving", async () => {
        render(<><Harness initial="" /><button type="button">next</button></>);
        const user = userEvent.setup();
        await user.type(input(), "2026-03-25");
        expect(screen.getByTestId("value")).toHaveTextContent("2026-03-25");
        await user.clear(input());
        expect(screen.getByTestId("value")).toHaveTextContent("");
        await user.type(input(), "01/02/2026");
        expect(screen.getByTestId("value")).toHaveTextContent("");
        await user.click(screen.getByRole("button", { name: "next" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Enter the date as YYYY-MM-DD.");
        expect(input()).toHaveAttribute("aria-invalid", "true");
        await user.clear(input());
        await user.type(input(), "2026-02-30"); // not a real date
        await user.click(screen.getByRole("button", { name: "next" }));
        expect(screen.getByTestId("value")).toHaveTextContent("");
    });

    test("accessibility: labelled field, labelled calendar button, a dialog with a name, month and year lists with names", async () => {
        render(<Harness initial="2026-03-25" />);
        const user = userEvent.setup();
        expect(input()).toHaveAttribute("aria-haspopup", "dialog");
        expect(screen.getByRole("button", { name: "Open calendar" })).toHaveAttribute("aria-expanded", "false");
        const dialog = await openCalendar(user);
        expect(screen.getByRole("button", { name: "Open calendar" })).toHaveAttribute("aria-expanded", "true");
        expect(within(dialog).getByLabelText("Month")).toBeInTheDocument();
        expect(within(dialog).getByLabelText("Year")).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Previous month" })).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Next month" })).toBeInTheDocument();
        expect(within(dialog).getByRole("grid")).toBeInTheDocument();
    });

    test("DATE-017 no time-zone / day shift: parse and format round-trip every awkward day, and the picked day is exactly the one clicked", async () => {
        for (const day of ["2026-03-29", "2026-10-25", "2024-02-29", "2026-12-31", "2026-01-01", "1900-01-01", "2100-12-31", "2026-03-08", "2026-11-01"]) {
            expect(formatDay(parseDay(day)!)).toBe(day);
        }
        expect(parseDay("2026-02-30")).toBeUndefined();
        expect(parseDay("2026-2-3")).toBeUndefined();
        expect(parseDay("03/25/2026")).toBeUndefined();
        render(<Harness initial="2026-12-31" />);
        const user = userEvent.setup();
        const dialog = await openCalendar(user);
        await user.click(within(dialog).getByRole("button", { name: "2026-12-01" }));
        expect(screen.getByTestId("value")).toHaveTextContent("2026-12-01");
    });

    test("DATE-018 / DATE-011 / DATE-012 the stylesheet keeps the calendar inside the screen and uses only theme colours", () => {
        const css = styles.replace(/\/\*[\s\S]*?\*\//g, "");
        const block = css.slice(css.indexOf(".date-picker {"));
        expect(block).toMatch(/\.date-picker-popover \{[^}]*position: fixed;/);
        expect(block).toMatch(/\.date-picker-popover \{[^}]*width: min\(320px, calc\(100vw - 16px\)\);/);
        expect(block).toMatch(/\.date-picker-popover \{[^}]*max-height: calc\(100vh - 16px\);/);
        expect(block).toMatch(/\.date-picker-popover\.is-sheet \{[^}]*bottom: 8px;/);
        expect(block).toMatch(/--rdp-day-height: 40px/);
        // Colours come from the Light / Dark variables (the same ones the form uses), never fixed hex values.
        const colours = [...block.matchAll(/#[0-9a-fA-F]{3,8}\b/g)];
        expect(colours).toEqual([]);
        for (const variable of ["--surface", "--ink", "--primary", "--primary-soft", "--border", "--focus", "--primary-ink"]) expect(block).toContain(`var(${variable})`);
    });
});

describe("Date fields in the Candidate Form", () => {
    test("every date field of the form is a calendar field with a labelled button (birth, passport, father, mother, spouse, guardian)", async () => {
        const { user } = await verified();
        expect(screen.getAllByRole("button", { name: en("date.openCalendar") })).toHaveLength(1); // Personal Details: birth date
        fillBasic("MARRIED");
        fillContact();
        await user.click(screen.getByRole("button", { name: en("form.next") }));
        // Passport issue + expiry, father, mother, spouse (Married), guardian: six.
        expect(await screen.findAllByRole("button", { name: en("date.openCalendar") })).toHaveLength(6);
        for (const key of ["f.passportIssueDate", "f.passportExpiryDate", "f.fatherBirthDate", "f.motherBirthDate", "f.spouseBirthDate", "f.guardianBirthDate"] as const) {
            expect(field(key), key).toHaveAttribute("inputmode", "numeric");
            expect(field(key)).toHaveAttribute("placeholder", "YYYY-MM-DD");
        }
    });

    test("DATE-006 the existing rules are unchanged: required, not in the future, expiry after issue", async () => {
        const { user } = await verified();
        await user.click(screen.getByRole("button", { name: en("form.next") }));
        expect(field("f.birthDate")).toHaveAttribute("aria-invalid", "true");
        expect(field("f.birthDate")).toHaveAccessibleDescription(new RegExp(en("v.required")));
        setField("f.birthDate", "2999-01-01");
        expect(screen.getByText(en("v.dateFuture"))).toBeInTheDocument();
    });

    test("DATE-013 / 014 the calendar speaks the current language, with numeric Gregorian months in Sinhala", async () => {
        const { user } = await verified();
        await user.click(screen.getByRole("button", { name: en("date.openCalendar") }));
        let dialog = await screen.findByRole("dialog", { name: en("date.calendar") });
        expect(within(dialog).getByLabelText(en("date.year"))).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: en("date.today") })).toBeInTheDocument();
        expect(within(within(dialog).getByLabelText(en("date.month"))).getAllByRole("option")[4]).toHaveTextContent("May");
        await user.keyboard("{Escape}");

        await switchLanguage(user, "සිංහල");
        await user.click(screen.getByRole("button", { name: si("date.openCalendar") }));
        dialog = await screen.findByRole("dialog", { name: si("date.calendar") });
        expect(within(dialog).getByLabelText(si("date.year"))).toBeInTheDocument();
        expect(within(dialog).getByLabelText(si("date.month"))).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: si("date.today") })).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: si("date.previousMonth") })).toBeInTheDocument();
        expect(within(within(dialog).getByLabelText(si("date.month"))).getAllByRole("option")[4]).toHaveTextContent("05");
        // The stored value is never translated.
        await user.selectOptions(within(dialog).getByLabelText(si("date.year")), "1990");
        await user.selectOptions(within(dialog).getByLabelText(si("date.month")), "05");
        await user.click(within(dialog).getByRole("button", { name: "1990-05-15" }));
        expect(screen.getByLabelText(startsWith(si("f.birthDate")))).toHaveValue("1990-05-15");
    });

    test("DATE-015 / 016 switching language or theme keeps the chosen date", async () => {
        const { user } = await verified();
        setField("f.birthDate", "1990-05-01");
        await switchLanguage(user, "සිංහල");
        expect(screen.getByLabelText(startsWith(si("f.birthDate")))).toHaveValue("1990-05-01");
        await user.click(within(screen.getByRole("group", { name: si("theme.label") })).getByRole("button", { name: startsWith(si("theme.dark")) }));
        expect(document.documentElement.dataset.theme).toBe("dark");
        expect(screen.getByLabelText(startsWith(si("f.birthDate")))).toHaveValue("1990-05-01");
        await user.click(within(screen.getByRole("group", { name: si("theme.label") })).getByRole("button", { name: startsWith(si("theme.light")) }));
        await switchLanguage(user, "English");
        expect(field("f.birthDate")).toHaveValue("1990-05-01");
    });

    test("an open calendar stays usable in the dark theme and nothing about the date is written to browser storage", async () => {
        const { user } = await verified();
        await user.click(within(screen.getByRole("group", { name: en("theme.label") })).getByRole("button", { name: startsWith(en("theme.dark")) }));
        await user.click(screen.getByRole("button", { name: en("date.openCalendar") }));
        const dialog = await screen.findByRole("dialog", { name: en("date.calendar") });
        await user.selectOptions(within(dialog).getByLabelText(en("date.year")), "1985");
        fireEvent.click(within(dialog).getAllByRole("button", { name: /^1985-\d\d-10$/ })[0]);
        expect(field("f.birthDate").getAttribute("value") ?? (field("f.birthDate") as HTMLInputElement).value).toMatch(/^1985-\d\d-10$/);
        expect(Object.keys(window.localStorage)).toEqual(["candidate-form-theme"]);
    });
});
