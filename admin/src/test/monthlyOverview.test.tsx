import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { MonthlyOverview } from "../api/admin";
import { MONTHLY_OVERVIEW_KEY, shiftMonth } from "../pages/OverviewPage";
import { renderApp, signedInBackend } from "./helpers";

// Synthetic figures only.
const monthly = (month: string, figures: Partial<MonthlyOverview> = {}, thisMonth = "2026-10"): MonthlyOverview => ({
    month,
    thisMonth,
    isCurrentMonth: month === thisMonth,
    timeZone: "Asia/Colombo",
    range: { start: "2026-09-30T18:30:00.000Z", end: "2026-10-31T18:30:00.000Z" },
    candidatesRegistered: 0,
    documentsSubmitted: 0,
    successfullyProcessed: 0,
    pending: 0,
    rejected: 0,
    manualReview: 0,
    sources: { whatsappSubmissions: 0, adminUploads: 0 },
    ...figures,
});

const OCTOBER = monthly("2026-10", { candidatesRegistered: 12, documentsSubmitted: 40, successfullyProcessed: 31, pending: 2, rejected: 1, manualReview: 6 });
const SEPTEMBER = monthly("2026-09", { candidatesRegistered: 7, documentsSubmitted: 25, successfullyProcessed: 20, pending: 0, rejected: 3, manualReview: 4 });

// The server answers any requested month; `thisMonth` is its current business month.
function backend(thisMonth = "2026-10") {
    return signedInBackend({
        "GET /api/admin/reports/monthly": (url) => {
            const month = url.searchParams.get("month") ?? thisMonth;
            if (thisMonth === "2026-10" && month === "2026-10") return { status: 200, body: OCTOBER };
            if (thisMonth === "2026-10" && month === "2026-09") return { status: 200, body: SEPTEMBER };
            return { status: 200, body: monthly(month, {}, thisMonth) };
        },
    });
}

const figure = (list: HTMLElement, label: string) => within(within(list).getByText(label).closest("li")!).getAllByText(/\d/)[0].textContent;
const previous = () => screen.getByRole("button", { name: "Previous month" });
const next = () => screen.getByRole("button", { name: "Next month" });
const selectedMonth = () => screen.getByTestId("selected-month").textContent;
const monthlyCalls = (calls: { path: string }[]) => calls.filter((c) => c.path.startsWith("/api/admin/reports/monthly")).map((c) => c.path);

describe("shiftMonth", () => {
    test("moves exactly one month and crosses year boundaries", () => {
        expect(shiftMonth("2026-10", -1)).toBe("2026-09");
        expect(shiftMonth("2026-10", 1)).toBe("2026-11");
        expect(shiftMonth("2027-01", -1)).toBe("2026-12");
        expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    });
});

describe("Monthly overview", () => {
    test("off by default: hidden, and the dashboard makes no extra request", async () => {
        const { calls } = backend();
        renderApp("/");
        await screen.findByText("1,428");
        expect(screen.getByRole("button", { name: "Monthly overview" })).toHaveAttribute("aria-pressed", "false");
        expect(screen.queryByRole("heading", { name: "Monthly overview" })).not.toBeInTheDocument();
        expect(monthlyCalls(calls)).toEqual([]);
    });

    test("toggle on shows this month's figures; toggle off hides them; the choice is remembered", async () => {
        backend();
        const { unmount } = renderApp("/");
        await screen.findByText("1,428");
        const user = userEvent.setup();
        const toggle = screen.getByRole("button", { name: "Monthly overview" });

        await user.click(toggle);
        expect(toggle).toHaveAttribute("aria-pressed", "true");
        const list = await screen.findByRole("list", { name: "Monthly overview for October 2026" });
        expect(figure(list, "Candidates registered")).toBe("12");
        expect(figure(list, "Documents submitted")).toBe("40");
        expect(figure(list, "Processed")).toBe("31");
        expect(figure(list, "Pending")).toBe("2");
        expect(figure(list, "Rejected")).toBe("1");
        expect(figure(list, "Manual review")).toBe("6");
        expect(window.localStorage.getItem(MONTHLY_OVERVIEW_KEY)).toBe("on");

        // Remembered after a reload.
        unmount();
        renderApp("/");
        expect(await screen.findByRole("list", { name: "Monthly overview for October 2026" })).toBeInTheDocument();

        await userEvent.setup().click(screen.getByRole("button", { name: "Monthly overview" }));
        expect(screen.queryByRole("heading", { name: "Monthly overview" })).not.toBeInTheDocument();
        expect(window.localStorage.getItem(MONTHLY_OVERVIEW_KEY)).toBe("off");
        // The rest of the Overview is untouched.
        expect(screen.getByText("1,428")).toBeInTheDocument();
    });

    test("opens on the current month, with Previous/Next arrows instead of the old dropdown", async () => {
        window.localStorage.setItem(MONTHLY_OVERVIEW_KEY, "on");
        backend();
        renderApp("/");
        await screen.findByRole("list", { name: "Monthly overview for October 2026" });
        expect(selectedMonth()).toBe("October 2026");
        expect(within(screen.getByRole("group", { name: "Month" })).getAllByRole("button")).toHaveLength(2);
        expect(previous()).toBeEnabled();
        // The current month: no way forward.
        expect(next()).toBeDisabled();
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
        expect(screen.queryByRole("option")).not.toBeInTheDocument();
    });

    test("Previous and Next move exactly one month and request that month; an empty month shows zeros", async () => {
        window.localStorage.setItem(MONTHLY_OVERVIEW_KEY, "on");
        const { calls } = backend();
        renderApp("/");
        await screen.findByRole("list", { name: "Monthly overview for October 2026" });
        const user = userEvent.setup();

        await user.click(previous());
        const september = await screen.findByRole("list", { name: "Monthly overview for September 2026" });
        expect(selectedMonth()).toBe("September 2026");
        expect(figure(september, "Documents submitted")).toBe("25");
        expect(figure(september, "Rejected")).toBe("3");
        expect(monthlyCalls(calls)).toContain("/api/admin/reports/monthly?month=2026-09");
        expect(next()).toBeEnabled();

        await user.click(previous());
        const august = await screen.findByRole("list", { name: "Monthly overview for August 2026" });
        for (const label of ["Candidates registered", "Documents submitted", "Processed", "Pending", "Rejected", "Manual review"]) {
            expect(figure(august, label), label).toBe("0");
        }
        expect(monthlyCalls(calls)).toContain("/api/admin/reports/monthly?month=2026-08");

        await user.click(next());
        expect(await screen.findByRole("list", { name: "Monthly overview for September 2026" })).toBeInTheDocument();
        await user.click(next());
        expect(await screen.findByRole("list", { name: "Monthly overview for October 2026" })).toBeInTheDocument();
        expect(selectedMonth()).toBe("October 2026");
        expect(next()).toBeDisabled();
    });

    test("a future month can't be reached: Next is disabled on the current month and pressing it requests nothing", async () => {
        window.localStorage.setItem(MONTHLY_OVERVIEW_KEY, "on");
        const { calls } = backend();
        renderApp("/");
        await screen.findByRole("list", { name: "Monthly overview for October 2026" });
        const before = monthlyCalls(calls).length;

        await userEvent.setup().click(next());
        // Keyboard too: a disabled button can't be focused or activated.
        next().focus();
        await userEvent.setup().keyboard("{Enter}");
        expect(selectedMonth()).toBe("October 2026");
        expect(monthlyCalls(calls)).toHaveLength(before);
        expect(monthlyCalls(calls).some((path) => path.endsWith("month=2026-11"))).toBe(false);
    });

    test("year boundaries: January 2027 → Previous → December 2026 → Next → January 2027", async () => {
        window.localStorage.setItem(MONTHLY_OVERVIEW_KEY, "on");
        const { calls } = backend("2027-01");
        renderApp("/");
        await screen.findByRole("list", { name: "Monthly overview for January 2027" });
        expect(next()).toBeDisabled();
        const user = userEvent.setup();

        await user.click(previous());
        expect(await screen.findByRole("list", { name: "Monthly overview for December 2026" })).toBeInTheDocument();
        expect(selectedMonth()).toBe("December 2026");
        expect(monthlyCalls(calls)).toContain("/api/admin/reports/monthly?month=2026-12");
        expect(next()).toBeEnabled();

        await user.click(next());
        expect(await screen.findByRole("list", { name: "Monthly overview for January 2027" })).toBeInTheDocument();
        expect(monthlyCalls(calls)).toContain("/api/admin/reports/monthly?month=2027-01");
        expect(next()).toBeDisabled();
    });

    test("the arrows work from the keyboard", async () => {
        window.localStorage.setItem(MONTHLY_OVERVIEW_KEY, "on");
        backend();
        renderApp("/");
        await screen.findByRole("list", { name: "Monthly overview for October 2026" });
        previous().focus();
        await userEvent.setup().keyboard("{Enter}");
        await waitFor(() => expect(selectedMonth()).toBe("September 2026"));
        expect(await screen.findByRole("list", { name: "Monthly overview for September 2026" })).toBeInTheDocument();
    });

    test("a failed request shows an error with a retry, and the rest of the Overview still works", async () => {
        window.localStorage.setItem(MONTHLY_OVERVIEW_KEY, "on");
        signedInBackend({ "GET /api/admin/reports/monthly": { status: 500, body: { message: "boom" } } });
        renderApp("/");
        expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
        expect(screen.getByText("1,428")).toBeInTheDocument();
    });

    test("the breadcrumb is in the header, not a row of the page content", async () => {
        window.localStorage.setItem(MONTHLY_OVERVIEW_KEY, "on");
        backend();
        renderApp("/");
        await screen.findByRole("list", { name: "Monthly overview for October 2026" });
        const breadcrumb = within(screen.getByRole("banner")).getByRole("navigation", { name: "Breadcrumb" });
        expect(within(breadcrumb).getByText("Overview")).toHaveAttribute("aria-current", "page");
        expect(within(screen.getByRole("main")).queryByRole("navigation", { name: "Breadcrumb" })).not.toBeInTheDocument();
    });
});
