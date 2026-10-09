import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { AuditLogItem, AuditLogList } from "../api/admin";
import { ADMIN, OVERVIEW, RENDER_STEP, SESSION_TOKEN, fakeAuth, renderApp, stubBackend, type FetchRoutes } from "./helpers";

// Admin > Audit Logs (ADMIN only, view only). Synthetic entries only; the
// backend is stubbed.

const PATH = "/api/admin/audit-logs";

const LONG_ADDRESS = "No. 1234/5, A Very Long Lane Name That Keeps Going, Off The Main Road Near The Old Temple, Negombo, Western Province, Sri Lanka 11500".repeat(2);

const ENTRY: AuditLogItem = {
    auditId: "00000000-0000-4000-8000-000000000001",
    createdDate: "2026-10-08T04:30:00.000Z",
    action: "UPDATE_CANDIDATE",
    category: "CANDIDATE",
    actor: { userId: "user-manager", name: "Mia Manager", role: "MANAGER" },
    candidate: { passportId: "N1023757", uniqueId: "0001", name: "Anusha De Soysa" },
    documentType: null,
    stage: null,
    previousStatus: "CREATED",
    newStatus: "UPDATED",
    previousValue: null,
    newValue: null,
    changes: [{ field: "address", from: null, to: LONG_ADDRESS }, { field: "jobExperience", from: "2 years", to: "3 years" }],
    details: null,
    policeSubmittedDate: null,
    reason: "Updated address, jobExperience",
};

const STAGE_ENTRY: AuditLogItem = {
    ...ENTRY,
    auditId: "00000000-0000-4000-8000-000000000002",
    createdDate: "2026-10-08T05:00:00.000Z",
    action: "UPDATE_STAGE",
    category: "STAGE",
    actor: { userId: "user-analyst", name: "Ali Analyst", role: "ANALYST" },
    stage: "IVS_INTERVIEW",
    previousStatus: "NOT_COMPLETED",
    newStatus: "COMPLETED",
    changes: [{ field: "completed", from: false, to: true }, { field: "notes", from: null, to: "Interview passed" }],
    reason: "Interview passed",
};

const ROLE_ENTRY: AuditLogItem = {
    ...ENTRY,
    auditId: "00000000-0000-4000-8000-000000000003",
    action: "UPDATE_USER_ROLE",
    category: "USER",
    actor: { userId: "admin-1", name: "Test Admin", role: "ADMIN" },
    candidate: null,
    previousStatus: "ANALYST",
    newStatus: "MANAGER",
    previousValue: "ANALYST",
    newValue: "MANAGER",
    changes: null,
    reason: "Role changed for user user-analyst",
};

const FILTERS: AuditLogList["filters"] = {
    users: [
        { userId: "user-analyst", name: "Ali Analyst", role: "ANALYST", status: "ACTIVE" },
        { userId: "user-manager", name: "Mia Manager", role: "MANAGER", status: "ACTIVE" },
        { userId: "admin-1", name: "Test Admin", role: "ADMIN", status: "ACTIVE" },
    ],
    categories: [
        { category: "CANDIDATE", actions: ["CREATE_CANDIDATE", "UPDATE_CANDIDATE"] },
        { category: "STAGE", actions: ["UPDATE_STAGE"] },
        { category: "DOCUMENT", actions: ["UPLOAD_DOCUMENT", "REMOVE_DOCUMENT"] },
        { category: "REVIEW", actions: ["APPROVE"] },
        { category: "USER", actions: ["UPDATE_USER_ROLE"] },
        { category: "OTHER", actions: [] },
    ],
    actions: ["CREATE_CANDIDATE", "UPDATE_CANDIDATE", "UPDATE_STAGE", "UPLOAD_DOCUMENT", "REMOVE_DOCUMENT", "APPROVE", "UPDATE_USER_ROLE"],
};

const page = (items: AuditLogItem[], { page = 1, pageSize = 25, total = items.length } = {}): AuditLogList => ({
    items,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    filters: FILTERS,
});

function asRole(role: string, routes: FetchRoutes = {}) {
    fakeAuth.setSession(SESSION_TOKEN);
    return stubBackend({ "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } }, "GET /api/admin/overview": { status: 200, body: OVERVIEW }, ...routes });
}

const auditCalls = (calls: { path: string; url: URL }[]) => calls.filter((c) => c.url.pathname === PATH);
const lastQuery = (calls: { path: string; url: URL }[]) => auditCalls(calls).at(-1)!.url.searchParams;
const navLinks = () => within(screen.getByRole("navigation", { name: "Main navigation" })).getAllByRole("link").map((l) => l.textContent);

describe("Audit Logs navigation and access", () => {
    test("ADMIN: Audit Logs sits after Change Roles and before Settings, and opens the page", async () => {
        asRole("ADMIN", { [`GET ${PATH}`]: { status: 200, body: page([ENTRY]) } });
        renderApp("/");
        await screen.findByTestId("admin-name");
        expect(navLinks().slice(-3)).toEqual(["Change Roles", "Audit Logs", "Settings"]);
        await userEvent.setup().click(screen.getByRole("link", { name: "Audit Logs" }));
        expect(await screen.findByRole("heading", { name: "Audit Logs", level: 1 })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Audit Logs" })).toHaveAttribute("aria-current", "page");
        expect(await screen.findAllByTestId("audit-row")).toHaveLength(1);
    });

    for (const role of ["MANAGER", "ANALYST", "REGISTRATION_DESK"]) {
        test(`${role}: no Audit Logs link; opening the URL shows Access Restricted and never calls the API`, async () => {
            const { calls } = asRole(role, { [`GET ${PATH}`]: { status: 403, body: { message: "Insufficient permissions" } } });
            renderApp("/audit-logs");
            await screen.findByTestId("admin-name");
            expect(navLinks()).not.toContain("Audit Logs");
            expect(await screen.findByRole("heading", { name: "Access Restricted" })).toBeInTheDocument();
            expect(screen.queryByTestId("audit-row")).toBeNull();
            expect(auditCalls(calls)).toHaveLength(0);
        });
    }
});

describe("Audit Logs page", () => {
    test("rows show date, action, who did it with their role, the candidate, category, old → new and the notes", async () => {
        asRole("ADMIN", { [`GET ${PATH}`]: { status: 200, body: page([STAGE_ENTRY, ENTRY, ROLE_ENTRY]) } });
        renderApp("/audit-logs");
        const rows = await screen.findAllByTestId("audit-row", {}, RENDER_STEP);
        expect(rows).toHaveLength(3);

        const stage = within(rows[0]);
        expect(stage.getByText("Stage updated")).toBeInTheDocument();
        expect(stage.getByText("IVS interview")).toBeInTheDocument();
        expect(stage.getByText("Ali Analyst")).toBeInTheDocument();
        expect(stage.getByText("Analyst")).toBeInTheDocument();
        expect(stage.getByRole("link", { name: "Anusha De Soysa" })).toHaveAttribute("href", "/candidates/N1023757");
        expect(stage.getByText("N1023757 · 0001")).toBeInTheDocument();
        expect(stage.getByText("Completed")).toBeInTheDocument();
        expect(stage.getByText("No")).toBeInTheDocument();
        expect(stage.getByText("Yes")).toBeInTheDocument();
        expect(stage.getAllByText("Interview passed").length).toBeGreaterThan(0);
        expect(rows[0]).toHaveTextContent(/08 Oct 2026, 10:30/);

        const details = within(rows[1]);
        expect(details.getByText("Candidate details updated")).toBeInTheDocument();
        expect(details.getByText("Job experience")).toBeInTheDocument();
        expect(details.getByText("2 years")).toBeInTheDocument();
        expect(details.getByText("3 years")).toBeInTheDocument();
        expect(details.queryByText("Updated address, jobExperience")).toBeNull();

        const role = within(rows[2]);
        expect(role.getByText("Role changed")).toBeInTheDocument();
        expect(role.getByText("ANALYST")).toBeInTheDocument();
        expect(role.getByText("MANAGER")).toBeInTheDocument();
        expect(rows[2]).toHaveTextContent("—");

        // View only: nothing to edit, delete, clear or roll back.
        for (const name of [/edit/i, /delete/i, /remove/i, /rollback|roll back|undo/i]) {
            expect(screen.queryByRole("button", { name })).toBeNull();
        }
        expect(screen.getByRole("button", { name: "Clear filters" })).toBeDisabled();
    });

    test("a long value wraps and is clamped, with the full text in a tooltip", async () => {
        asRole("ADMIN", { [`GET ${PATH}`]: { status: 200, body: page([ENTRY]) } });
        renderApp("/audit-logs");
        const [row] = await screen.findAllByTestId("audit-row", {}, RENDER_STEP);
        const address = within(row).getByText(LONG_ADDRESS);
        const line = address.closest("span.block") as HTMLElement;
        expect(line.className).toContain("line-clamp-3");
        expect(line.className).toContain("[overflow-wrap:anywhere]");
        expect(address.closest("li")).toHaveAttribute("title", expect.stringContaining(LONG_ADDRESS));
        const cell = address.closest("td") as HTMLElement;
        expect(cell.className).toMatch(/max-w-\[22rem\]/);
        expect(cell.className).not.toContain("whitespace-nowrap");
    });

    test("loading, then empty (no entries yet)", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        asRole("ADMIN", { [`GET ${PATH}`]: async () => { await held; return { status: 200, body: page([]) }; } });
        renderApp("/audit-logs");
        expect(await screen.findByText("Loading audit logs…", {}, RENDER_STEP)).toBeInTheDocument();
        release();
        expect(await screen.findByText("No audit entries yet", {}, RENDER_STEP)).toBeInTheDocument();
    });

    test("empty with filters offers to clear them", async () => {
        const { calls } = asRole("ADMIN", { [`GET ${PATH}`]: { status: 200, body: page([]) } });
        renderApp("/audit-logs?action=APPROVE&pageSize=50");
        expect(await screen.findByText("No entries match these filters", {}, RENDER_STEP)).toBeInTheDocument();
        const clear = screen.getAllByRole("button", { name: "Clear filters" });
        await userEvent.setup().click(clear[clear.length - 1]);
        await waitFor(() => expect(lastQuery(calls).get("action")).toBeNull());
        expect(lastQuery(calls).get("pageSize")).toBe("50");
    });

    test("an error is shown with Try again", async () => {
        let fail = true;
        asRole("ADMIN", { [`GET ${PATH}`]: () => (fail ? { status: 500, body: { message: "The audit log could not be loaded." } } : { status: 200, body: page([ENTRY]) }) });
        renderApp("/audit-logs");
        // A server error shows the generic message (api/client.ts), never the server's text.
        expect(await screen.findByText("Something went wrong. Please try again.", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByTestId("audit-row")).toBeNull();
        fail = false;
        await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findAllByTestId("audit-row", {}, RENDER_STEP)).toHaveLength(1);
    });

    test("filter by the user who did it", async () => {
        const { calls } = asRole("ADMIN", { [`GET ${PATH}`]: (url) => ({ status: 200, body: page(url.searchParams.get("adminId") === "user-analyst" ? [STAGE_ENTRY] : [STAGE_ENTRY, ENTRY]) }) });
        renderApp("/audit-logs");
        expect(await screen.findAllByTestId("audit-row", {}, RENDER_STEP)).toHaveLength(2);
        const select = screen.getByLabelText("Performed by");
        expect(within(select).getByRole("option", { name: "Ali Analyst (Analyst)" })).toBeInTheDocument();
        await userEvent.setup().selectOptions(select, "user-analyst");
        await waitFor(() => expect(lastQuery(calls).get("adminId")).toBe("user-analyst"));
        await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(1));
        expect(lastQuery(calls).get("page")).toBe("1");
    });

    test("filter by candidate (passport ID, unique ID or name) and free-text search, applied together", async () => {
        const { calls } = asRole("ADMIN", { [`GET ${PATH}`]: { status: 200, body: page([ENTRY]) } });
        renderApp("/audit-logs");
        await screen.findAllByTestId("audit-row", {}, RENDER_STEP);
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Candidate"), "N1023757");
        await user.type(screen.getByLabelText("Search"), "address");
        expect(lastQuery(calls).get("candidate")).toBeNull();
        await user.click(screen.getByRole("button", { name: "Apply" }));
        await waitFor(() => expect(lastQuery(calls).get("candidate")).toBe("N1023757"));
        expect(lastQuery(calls).get("search")).toBe("address");
    });

    test("category narrows the actions; dates are sent as From / To", async () => {
        const { calls } = asRole("ADMIN", { [`GET ${PATH}`]: { status: 200, body: page([STAGE_ENTRY]) } });
        renderApp("/audit-logs");
        await screen.findAllByTestId("audit-row", {}, RENDER_STEP);
        const user = userEvent.setup();
        await user.selectOptions(screen.getByLabelText("Category"), "STAGE");
        await waitFor(() => expect(lastQuery(calls).get("category")).toBe("STAGE"));
        const actions = within(screen.getByLabelText("Action")).getAllByRole("option").map((o) => o.textContent);
        expect(actions).toEqual(["All actions", "Stage updated"]);
        await user.selectOptions(screen.getByLabelText("Action"), "UPDATE_STAGE");
        await waitFor(() => expect(lastQuery(calls).get("action")).toBe("UPDATE_STAGE"));

        await user.type(screen.getByLabelText("From"), "2026-10-01");
        await waitFor(() => expect(lastQuery(calls).get("startDate")).toBe("2026-10-01"));
        await user.type(screen.getByLabelText("To"), "2026-10-08");
        await waitFor(() => expect(lastQuery(calls).get("endDate")).toBe("2026-10-08"));
        expect(lastQuery(calls).get("category")).toBe("STAGE");
    });

    test("server-side pagination: Next / Previous and the page size", async () => {
        const { calls } = asRole("ADMIN", {
            [`GET ${PATH}`]: (url) => {
                const pageNumber = Number(url.searchParams.get("page") ?? 1);
                const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
                return { status: 200, body: page([{ ...ENTRY, auditId: `id-${pageNumber}` }], { page: pageNumber, pageSize, total: 60 }) };
            },
        });
        renderApp("/audit-logs");
        expect(await screen.findByText("Page 1 of 3", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByText("60 entries")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
        expect(lastQuery(calls).get("page")).toBe("2");
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("Page 3 of 3")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

        await user.selectOptions(screen.getByLabelText("Rows"), "100");
        expect(await screen.findByText("Page 1 of 1")).toBeInTheDocument();
        expect(lastQuery(calls).get("pageSize")).toBe("100");
        expect(lastQuery(calls).get("page")).toBe("1");
    });
});
