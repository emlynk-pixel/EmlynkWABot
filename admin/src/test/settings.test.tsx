import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { SheetSyncRun, SheetSyncStatus } from "../api/sheetSync";
import { ADMIN, renderApp, signedInBackend, stubBackend, fakeJwt, TOKEN_KEY, OVERVIEW, type FetchRoutes } from "./helpers";

// Settings -> Google Sheet Sync. Synthetic data only; the backend is stubbed.

const RUN: SheetSyncRun = {
    runId: "00000000-0000-4000-8000-000000000001", kind: "RECONCILE", trigger: "ADMIN", status: "SUCCEEDED", dryRun: true,
    createdAt: "2026-10-06T03:00:00.000Z", startedAt: "2026-10-06T03:00:01.000Z", finishedAt: "2026-10-06T03:00:09.000Z",
    errorClass: null, errorCode: null,
    summary: { appended: 4, updated: 2, unchanged: 30, markedInactive: 0, notInDatabase: 0, deletionGuardTriggered: false },
};

const STATUS: SheetSyncStatus = {
    worker: { online: true, lastHeartbeatAt: "2026-10-06T09:00:00.000Z" },
    configured: true,
    writeGate: "DISABLED",
    target: "…JirMpE / Emlynk Candidate Operational Mirror",
    integration: { state: "OK", lastErrorClass: null, lastErrorCode: null, lastErrorAt: null },
    queue: { pending: 3, processing: 0, failed: 1 },
    lastSuccessfulSyncAt: null,
    lastReconciliation: RUN,
    lastSuccessfulReconciliationAt: RUN.finishedAt,
    lastConnectionTest: { ...RUN, kind: "TEST_CONNECTION", dryRun: null, summary: { status: "CONNECTED", schema: "SCHEMA_VALID" } },
    activeRuns: { reconcile: null, testConnection: null },
};

const STATUS_PATH = "/api/admin/settings/sheet-sync/status";

function asRole(role: string, routes: FetchRoutes = {}) {
    window.sessionStorage.setItem(TOKEN_KEY, fakeJwt());
    return stubBackend({ "GET /auth/me": { status: 200, body: { admin: { ...ADMIN, role } } }, "GET /api/admin/overview": { status: 200, body: OVERVIEW }, ...routes });
}

const settingsCalls = (calls: { path: string }[]) => calls.filter((c) => c.path.startsWith("/api/admin/settings"));

describe("Settings navigation", () => {
    test("ADMIN: Settings is the last sidebar item, after Change Roles; active state and breadcrumb on /settings", async () => {
        signedInBackend({ [`GET ${STATUS_PATH}`]: { status: 200, body: STATUS } });
        renderApp("/settings");
        const nav = await screen.findByRole("navigation", { name: "Main navigation" });
        const labels = within(nav).getAllByRole("link").map((l) => l.textContent);
        expect(labels.slice(-3)).toEqual(["Invite Admin", "Change Roles", "Settings"]);
        expect(within(nav).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
        expect(within(nav).getByRole("link", { name: "Change Roles" })).not.toHaveAttribute("aria-current");
        expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeInTheDocument();
        expect(within(screen.getByRole("navigation", { name: /breadcrumb/i })).getByText("Settings")).toBeInTheDocument();
    });

    test("ADMIN: clicking Settings in the sidebar opens the page with the Google Sheet Sync section (no separate sidebar item)", async () => {
        signedInBackend({ [`GET ${STATUS_PATH}`]: { status: 200, body: STATUS } });
        renderApp("/");
        const nav = await screen.findByRole("navigation", { name: "Main navigation" });
        expect(within(nav).queryByRole("link", { name: /google sheet/i })).toBeNull();
        await userEvent.setup().click(within(nav).getByRole("link", { name: "Settings" }));
        expect(await screen.findByRole("heading", { name: "Google Sheet Sync" })).toBeInTheDocument();
    });

    for (const role of ["MANAGER", "ANALYST", "REGISTRATION_DESK"]) {
        test(`${role}: no Settings item; a direct visit shows Access Restricted and requests no Settings data`, async () => {
            const { calls } = asRole(role);
            renderApp("/settings");
            expect(await screen.findByRole("heading", { name: "Access Restricted" })).toBeInTheDocument();
            const nav = screen.getByRole("navigation", { name: "Main navigation" });
            expect(within(nav).queryByRole("link", { name: "Settings" })).toBeNull();
            expect(screen.queryByRole("heading", { name: "Google Sheet Sync" })).toBeNull();
            expect(settingsCalls(calls)).toEqual([]);
        });
    }
});

describe("Google Sheet Sync section", () => {
    test("loads and shows the status: connection, write gate (dry-run note), last runs, queue, target hint", async () => {
        signedInBackend({ [`GET ${STATUS_PATH}`]: { status: 200, body: STATUS } });
        renderApp("/settings");
        expect(await screen.findByText("Connected · schema valid")).toBeInTheDocument();
        expect(screen.getByText("Disabled")).toBeInTheDocument();
        expect(screen.getByText(/Sync Now runs a dry run/)).toBeInTheDocument();
        expect(screen.getByText("4 would be appended · 2 would be updated · 30 unchanged")).toBeInTheDocument();
        expect(screen.getByText("Succeeded (dry run)")).toBeInTheDocument();
        expect(screen.getByText("3 / 1")).toBeInTheDocument();
        expect(screen.getByText("…JirMpE / Emlynk Candidate Operational Mirror")).toBeInTheDocument();
    });

    test("shows a loading state first, and an error inside the section only when the status request fails", async () => {
        let resolve: (value: { status: number; body: unknown }) => void = () => {};
        signedInBackend({ [`GET ${STATUS_PATH}`]: () => new Promise((r) => { resolve = r; }) });
        renderApp("/settings");
        expect(await screen.findByText("Loading sync status…")).toBeInTheDocument();
        resolve({ status: 503, body: { message: "Service unavailable" } });
        expect(await screen.findByRole("alert")).toBeInTheDocument();
        // The rest of the console still works.
        expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Google Sheet Sync" })).toBeInTheDocument();
    });

    test("Sync Now and Test Connection send POST requests and report that the run continues in the background", async () => {
        const { calls } = signedInBackend({
            [`GET ${STATUS_PATH}`]: { status: 200, body: STATUS },
            "POST /api/admin/settings/sheet-sync/run": { status: 202, body: { run: { ...RUN, status: "QUEUED" }, alreadyActive: false } },
            "POST /api/admin/settings/sheet-sync/test": { status: 202, body: { run: { ...RUN, kind: "TEST_CONNECTION", status: "QUEUED" }, alreadyActive: true } },
        });
        renderApp("/settings");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Sync Now" }));
        expect(await screen.findByText(/Sync requested\. It runs in the background; you can leave this page\./)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Test Connection" }));
        expect(await screen.findByText("Connection test is already queued or running.")).toBeInTheDocument();
        expect(settingsCalls(calls).filter((c) => c.path !== STATUS_PATH).map((c) => c.path)).toEqual([
            "/api/admin/settings/sheet-sync/run", "/api/admin/settings/sheet-sync/test",
        ]);
    });

    test("a refused action (backend 403) shows the server's message and claims no success", async () => {
        signedInBackend({
            [`GET ${STATUS_PATH}`]: { status: 200, body: STATUS },
            "POST /api/admin/settings/sheet-sync/run": { status: 403, body: { message: "Insufficient permissions" } },
        });
        renderApp("/settings");
        await userEvent.setup().click(await screen.findByRole("button", { name: "Sync Now" }));
        expect(await screen.findByText("Insufficient permissions")).toBeInTheDocument();
        expect(screen.queryByText(/Sync requested/)).toBeNull();
    });

    test("an active run disables its button and is shown as in progress", async () => {
        signedInBackend({ [`GET ${STATUS_PATH}`]: { status: 200, body: { ...STATUS, activeRuns: { reconcile: { ...RUN, status: "RUNNING", dryRun: null }, testConnection: null } } } });
        renderApp("/settings");
        expect(await screen.findByText("In progress")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Sync Now" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Test Connection" })).toBeEnabled();
        expect(screen.getByText("Running")).toBeInTheDocument();
    });

    test("a halted integration and an offline worker are shown plainly", async () => {
        signedInBackend({
            [`GET ${STATUS_PATH}`]: {
                status: 200,
                body: { ...STATUS, worker: { online: false, lastHeartbeatAt: null }, integration: { state: "DATA_INTEGRITY", lastErrorClass: "DUPLICATE_CANDIDATE_ID", lastErrorCode: "2", lastErrorAt: "2026-10-06T08:00:00.000Z" } },
            },
        });
        renderApp("/settings");
        expect(await screen.findByText(/The sheet-sync worker is not reporting/)).toBeInTheDocument();
        expect(screen.getByText("Duplicate candidate IDs in the Sheet: sync halted")).toBeInTheDocument();
        expect(screen.getByText(/Duplicate candidate id \(2\)/)).toBeInTheDocument();
    });

    test("the status is refreshed while a run is active", async () => {
        let polls = 0;
        signedInBackend({ [`GET ${STATUS_PATH}`]: () => { polls += 1; return { status: 200, body: { ...STATUS, activeRuns: { reconcile: { ...RUN, status: "QUEUED" }, testConnection: null } } }; } });
        renderApp("/settings");
        await screen.findByText("In progress");
        await waitFor(() => expect(polls).toBeGreaterThan(1), { timeout: 7_000 });
    }, 10_000);
});
