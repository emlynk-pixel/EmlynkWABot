import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { MonthlyOverview } from "../api/admin";
import { MONTHLY_OVERVIEW_KEY } from "../pages/OverviewPage";
import { renderApp, signedInBackend } from "./helpers";

// Synthetic figures only.
const monthly = (month: string, figures: Partial<MonthlyOverview> = {}): MonthlyOverview => ({
    month,
    thisMonth: "2026-10",
    isCurrentMonth: month === "2026-10",
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

function backend() {
    return signedInBackend({
        "GET /api/admin/reports/monthly": (url) => {
            const month = url.searchParams.get("month");
            if (month === "2026-09") return { status: 200, body: SEPTEMBER };
            if (month === "2026-08") return { status: 200, body: monthly("2026-08") };
            return { status: 200, body: OCTOBER };
        },
    });
}

const figure = (list: HTMLElement, label: string) => within(within(list).getByText(label).closest("li")!).getAllByText(/\d/)[0].textContent;

describe("Monthly overview", () => {
    test("off by default: hidden, and the dashboard makes no extra request", async () => {
        const { calls } = backend();
        renderApp("/");
        await screen.findByText("1,428");
        expect(screen.getByRole("button", { name: "Monthly overview" })).toHaveAttribute("aria-pressed", "false");
        expect(screen.queryByRole("heading", { name: "Monthly overview" })).not.toBeInTheDocument();
        expect(calls.some((c) => c.path.startsWith("/api/admin/reports/monthly"))).toBe(false);
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
        expect(screen.getByRole("combobox", { name: "Month" })).toHaveValue("2026-10");
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

    test("switching months requests and shows that month; an empty month shows zeros", async () => {
        window.localStorage.setItem(MONTHLY_OVERVIEW_KEY, "on");
        const { calls } = backend();
        renderApp("/");
        await screen.findByRole("list", { name: "Monthly overview for October 2026" });
        const user = userEvent.setup();
        const select = screen.getByRole("combobox", { name: "Month" });
        // Last 24 months, newest first, from the server's "this month".
        const options = within(select).getAllByRole("option");
        expect(options).toHaveLength(24);
        expect(options[0]).toHaveTextContent("October 2026");
        expect(options[23]).toHaveTextContent("November 2024");

        await user.selectOptions(select, "2026-09");
        const september = await screen.findByRole("list", { name: "Monthly overview for September 2026" });
        expect(figure(september, "Documents submitted")).toBe("25");
        expect(figure(september, "Rejected")).toBe("3");
        expect(calls.some((c) => c.path === "/api/admin/reports/monthly?month=2026-09")).toBe(true);

        await user.selectOptions(select, "2026-08");
        const august = await screen.findByRole("list", { name: "Monthly overview for August 2026" });
        for (const label of ["Candidates registered", "Documents submitted", "Processed", "Pending", "Rejected", "Manual review"]) {
            expect(figure(august, label), label).toBe("0");
        }
    });

    test("a failed request shows an error with a retry, and the rest of the Overview still works", async () => {
        window.localStorage.setItem(MONTHLY_OVERVIEW_KEY, "on");
        signedInBackend({ "GET /api/admin/reports/monthly": { status: 500, body: { message: "boom" } } });
        renderApp("/");
        expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
        expect(screen.getByText("1,428")).toBeInTheDocument();
    });
});
