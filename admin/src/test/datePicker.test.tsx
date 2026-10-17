import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { DatePicker, formatDay, parseDay } from "../components/DatePicker";
import fs from "node:fs";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend } from "./helpers";
import { CANDIDATE_STAGES, type CandidateDetails } from "../api/candidates";

// The reusable Admin DatePicker: a text field (YYYY-MM-DD) plus a calendar. The value is always a
// date-only string. Unit tests use the component directly; the screen tests use real Admin pages.

function Harness({ initial = "", min, max, required, onValue }: { initial?: string; min?: string; max?: string; required?: boolean; onValue?: (value: string) => void }) {
    const [value, setValue] = useState(initial);
    return (
        <>
            <label htmlFor="d">Date</label>
            <DatePicker id="d" value={value} onChange={(next) => { setValue(next); onValue?.(next); }} min={min} max={max} required={required} className="mt-1 h-9 w-full rounded border" />
            <output data-testid="value">{value}</output>
        </>
    );
}
const input = () => screen.getByLabelText("Date") as HTMLInputElement;
const openCalendar = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Open calendar" }));
    return screen.findByRole("dialog", { name: "Choose a date" });
};

describe("Admin DatePicker (component)", () => {
    test("DATE-001 / 002 / 003 opens from the button; a picked day is stored as YYYY-MM-DD; focus returns to the field", async () => {
        const seen: string[] = [];
        render(<Harness onValue={(v) => seen.push(v)} />);
        const user = userEvent.setup();
        const dialog = await openCalendar(user);
        await user.selectOptions(within(dialog).getByLabelText("Year"), "1990");
        await user.selectOptions(within(dialog).getByLabelText("Month"), "May");
        await user.click(within(dialog).getByRole("button", { name: "1990-05-15" }));
        expect(seen).toEqual(["1990-05-15"]);
        expect(input()).toHaveValue("1990-05-15");
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(input()).toHaveFocus();
    });

    test("DATE-004 / 005 the year list covers the allowed range: birth dates back to 1900 and passport dates far ahead, in one step", async () => {
        const first = render(<Harness min="1900-01-01" max="2026-10-17" />);
        const user = userEvent.setup();
        let dialog = await openCalendar(user);
        let years = within(within(dialog).getByLabelText("Year")).getAllByRole("option").map((o) => Number(o.textContent));
        expect([years[0], years.at(-1), years.length]).toEqual([1900, 2026, 127]);
        first.unmount();
        render(<Harness />);
        dialog = await openCalendar(user);
        years = within(within(dialog).getByLabelText("Year")).getAllByRole("option").map((o) => Number(o.textContent));
        expect(years).toContain(2045);
        await user.selectOptions(within(dialog).getByLabelText("Year"), "2045");
        await user.selectOptions(within(dialog).getByLabelText("Month"), "March");
        await user.click(within(dialog).getByRole("button", { name: "2045-03-09" }));
        expect(screen.getByTestId("value")).toHaveTextContent("2045-03-09");
    });

    test("days outside min and max are disabled", async () => {
        render(<Harness initial="2026-10-10" min="2026-10-05" max="2026-10-20" />);
        const dialog = await openCalendar(userEvent.setup());
        expect(within(dialog).getByRole("button", { name: "2026-10-04" })).toBeDisabled();
        expect(within(dialog).getByRole("button", { name: "2026-10-21" })).toBeDisabled();
        expect(within(dialog).getByRole("button", { name: "2026-10-12" })).toBeEnabled();
    });

    test("DATE-007 an optional date can be cleared; a required one has no Clear", async () => {
        const optional = render(<Harness initial="2026-03-25" />);
        const user = userEvent.setup();
        await user.click(within(await openCalendar(user)).getByRole("button", { name: "Clear" }));
        expect(input()).toHaveValue("");
        expect(screen.getByTestId("value")).toHaveTextContent("");
        optional.unmount();
        render(<Harness initial="2026-03-25" required />);
        expect(within(await openCalendar(user)).queryByRole("button", { name: "Clear" })).toBeNull();
    });

    test("DATE-008 / 009 Escape closes only the calendar (and returns focus); a click outside closes it", async () => {
        const behind = vi.fn();
        window.addEventListener("keydown", behind);
        render(<><Harness initial="2026-03-25" /><button type="button">elsewhere</button></>);
        const user = userEvent.setup();
        await openCalendar(user);
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(input()).toHaveFocus();
        expect(behind.mock.calls.filter(([event]) => (event as KeyboardEvent).key === "Escape")).toHaveLength(0);
        window.removeEventListener("keydown", behind);
        await openCalendar(user);
        await user.click(screen.getByRole("button", { name: "elsewhere" }));
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    test("DATE-010 keyboard: the selected day has focus, arrows move, Enter picks", async () => {
        render(<Harness initial="2026-03-25" />);
        const user = userEvent.setup();
        await openCalendar(user);
        expect(screen.getByRole("button", { name: "2026-03-25, selected" })).toHaveFocus();
        await user.keyboard("{ArrowRight}{ArrowDown}{Enter}");
        expect(screen.getByTestId("value")).toHaveTextContent("2026-04-02");
    });

    test("typing is one format only (YYYY-MM-DD): a real date is accepted, DD/MM/YYYY is refused with a message", async () => {
        render(<><Harness /><button type="button">next</button></>);
        const user = userEvent.setup();
        await user.type(input(), "2026-03-25");
        expect(screen.getByTestId("value")).toHaveTextContent("2026-03-25");
        await user.clear(input());
        await user.type(input(), "25/03/2026");
        await user.click(screen.getByRole("button", { name: "next" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Enter the date as YYYY-MM-DD");
        expect(screen.getByTestId("value")).toHaveTextContent("");
        expect(input()).toHaveAttribute("aria-invalid", "true");
    });

    test("DATE-017 no time-zone / day shift", async () => {
        for (const day of ["2026-03-29", "2026-10-25", "2024-02-29", "2026-12-31", "2026-01-01", "1900-01-01", "2100-12-31"]) expect(formatDay(parseDay(day)!)).toBe(day);
        expect(parseDay("2026-02-30")).toBeUndefined();
        render(<Harness initial="2026-12-31" />);
        const user = userEvent.setup();
        await user.click(within(await openCalendar(user)).getByRole("button", { name: "2026-12-01" }));
        expect(screen.getByTestId("value")).toHaveTextContent("2026-12-01");
    });

    test("DATE-018 / 011 / 012 the stylesheet keeps the calendar on screen and uses the Admin theme variables, so Light and Dark both work", () => {
        const css = fs.readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
        const block = css.slice(css.indexOf(".date-picker-row {"));
        expect(block).toMatch(/\.date-picker-popover \{[^}]*position: fixed;[^}]*width: min\(320px, calc\(100vw - 16px\)\);[^}]*max-height: calc\(100vh - 16px\);/);
        expect(block).toMatch(/\.date-picker-popover\.is-sheet \{[^}]*bottom: 8px;/);
        for (const variable of ["--color-surface", "--color-ink", "--color-primary", "--color-primary-soft", "--color-border-strong"]) expect(block).toContain(`var(${variable})`);
        // Only one fixed colour: the text on the selected day (white on the primary colour).
        expect([...block.matchAll(/#[0-9a-fA-F]{3,8}\b/g)]).toHaveLength(1);
    });

    test("accessibility: a labelled field and button, a named dialog, month and year lists, a day grid", async () => {
        render(<Harness initial="2026-03-25" />);
        const dialog = await openCalendar(userEvent.setup());
        expect(input()).toHaveAttribute("aria-haspopup", "dialog");
        expect(within(dialog).getByLabelText("Month")).toBeInTheDocument();
        expect(within(dialog).getByLabelText("Year")).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Previous month" })).toBeInTheDocument();
        expect(within(dialog).getByRole("grid")).toBeInTheDocument();
    });
});

describe("Admin screens use the date picker", () => {
    const DETAILS: CandidateDetails = {
        candidate: {
            passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], surname: "SILVA", otherNames: "SAMAN",
            dateOfBirth: "2003-06-05", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", passportIssueDate: "2020-05-11", nationality: null, sex: "M",
            address: "1 Main Street", jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null,
        },
        stages: CANDIDATE_STAGES.map((stage) => ({ stage, completed: false, completedAt: null, notes: null, jobId: null, testResult: null, testDate: null, automatic: stage === "CANDIDATE_DETAILS" || stage === "DOCUMENT_SUBMISSION", missing: [] })),
        documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null, VISA_SUBMISSION: null },
        variantDocuments: { POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null } },
        requiredDocuments: [],
    };
    const backend = () => signedInBackend({
        "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role: "ADMIN" } } },
        "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
        "GET /api/admin/candidates/N0000002/additional-details": { status: 200, body: { passportId: "N0000002", details: null, suggested: { nameAsInPassport: null, permanentAddress: null, birthday: null }, updatedDate: null } },
    });

    test("Candidate details: date of birth, passport issue and expiry are calendar fields; the stored value stays YYYY-MM-DD; an expiry far in the future can be picked", async () => {
        backend();
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
        const user = userEvent.setup();
        const birth = await screen.findByLabelText("Date of birth", undefined, RENDER_STEP);
        expect(birth).toHaveValue("2003-06-05");
        expect(birth).toHaveAttribute("placeholder", "YYYY-MM-DD");
        const expiry = document.querySelector<HTMLInputElement>('input[id$="passportExpiryDate"]')!;
        expect(expiry).toBeRequired();
        // Three calendar buttons on this form (birth, issue, expiry).
        const buttons = screen.getAllByRole("button", { name: "Open calendar" });
        expect(buttons).toHaveLength(3);
        await user.click(buttons[2]);
        const dialog = await screen.findByRole("dialog", { name: "Choose a date" });
        await user.selectOptions(within(dialog).getByLabelText("Year"), "2040");
        await user.selectOptions(within(dialog).getByLabelText("Month"), "August");
        await user.click(within(dialog).getByRole("button", { name: "2040-08-20" }));
        expect(expiry).toHaveValue("2040-08-20");
    });

    test("Additional details: an optional date can be cleared and is saved as empty", async () => {
        backend();
        renderApp("/candidates/N0000002?tab=additional");
        const user = userEvent.setup();
        const birthday = await screen.findByLabelText("Birthday", undefined, RENDER_STEP);
        await user.type(birthday, "1990-02-03");
        expect(birthday).toHaveValue("1990-02-03");
        const buttons = screen.getAllByRole("button", { name: "Open calendar" });
        await user.click(buttons[0]);
        await user.click(within(await screen.findByRole("dialog", { name: "Choose a date" })).getByRole("button", { name: "Clear" }));
        expect(birthday).toHaveValue("");
        expect(screen.getByLabelText("Father birthday")).toHaveAttribute("placeholder", "YYYY-MM-DD");
    });
});
