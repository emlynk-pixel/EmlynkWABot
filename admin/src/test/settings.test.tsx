import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { SheetSyncRun, SheetSyncStatus } from "../api/sheetSync";
import { ADMIN, renderApp, signedInBackend, stubBackend, OVERVIEW, type FetchRoutes, SESSION_TOKEN, fakeAuth, renderAppSignedIn, RENDER_STEP } from "./helpers";

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
    fakeAuth.setSession(SESSION_TOKEN);
    return stubBackend({ "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } }, "GET /api/admin/overview": { status: 200, body: OVERVIEW }, ...routes });
}

const settingsCalls = (calls: { path: string }[]) => calls.filter((c) => c.path.startsWith("/api/admin/settings"));

describe("Settings navigation", () => {
    test("ADMIN: Settings is the last sidebar item, after Audit Logs; no Invite User / Change Roles items; active state and breadcrumb on /settings", async () => {
        signedInBackend({ [`GET ${STATUS_PATH}`]: { status: 200, body: STATUS } });
        renderApp("/settings");
        const nav = await screen.findByRole("navigation", { name: "Main navigation" });
        const labels = within(nav).getAllByRole("link").map((l) => l.textContent);
        expect(labels.slice(-3)).toEqual(["Daily Report", "Audit Logs", "Settings"]);
        expect(within(nav).queryByRole("link", { name: "Invite User" })).toBeNull();
        expect(within(nav).queryByRole("link", { name: "Change Roles" })).toBeNull();
        expect(within(nav).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
        expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeInTheDocument();
        expect(within(screen.getByRole("navigation", { name: /breadcrumb/i })).getByText("Settings")).toBeInTheDocument();
    });

    test("ADMIN: clicking Settings in the sidebar opens Settings; its Google Sheet Sync tab shows the section (no separate sidebar item)", async () => {
        signedInBackend({ [`GET ${STATUS_PATH}`]: { status: 200, body: STATUS } });
        renderApp("/");
        const nav = await screen.findByRole("navigation", { name: "Main navigation" });
        expect(within(nav).queryByRole("link", { name: /google sheet/i })).toBeNull();
        await userEvent.setup().click(within(nav).getByRole("link", { name: "Settings" }));
        await userEvent.setup().click(await screen.findByRole("link", { name: "Google Sheet Sync" }));
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
        renderApp("/settings/sheet-sync");
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
        await renderAppSignedIn("/settings/sheet-sync");
        expect(await screen.findByText("Loading sync status…", {}, RENDER_STEP)).toBeInTheDocument();
        resolve({ status: 503, body: { message: "Service unavailable" } });
        expect(await screen.findByRole("alert", {}, RENDER_STEP)).toBeInTheDocument();
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
        renderApp("/settings/sheet-sync");
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
        renderApp("/settings/sheet-sync");
        await userEvent.setup().click(await screen.findByRole("button", { name: "Sync Now" }));
        expect(await screen.findByText("Insufficient permissions")).toBeInTheDocument();
        expect(screen.queryByText(/Sync requested/)).toBeNull();
    });

    test("an active run disables its button and is shown as in progress", async () => {
        signedInBackend({ [`GET ${STATUS_PATH}`]: { status: 200, body: { ...STATUS, activeRuns: { reconcile: { ...RUN, status: "RUNNING", dryRun: null }, testConnection: null } } } });
        renderApp("/settings/sheet-sync");
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
        renderApp("/settings/sheet-sync");
        expect(await screen.findByText(/The sheet-sync worker is not reporting/)).toBeInTheDocument();
        expect(screen.getByText("Duplicate candidate IDs in the Sheet: sync halted")).toBeInTheDocument();
        expect(screen.getByText(/Duplicate candidate id \(2\)/)).toBeInTheDocument();
    });

    test("the status is refreshed while a run is active", async () => {
        let polls = 0;
        signedInBackend({ [`GET ${STATUS_PATH}`]: () => { polls += 1; return { status: 200, body: { ...STATUS, activeRuns: { reconcile: { ...RUN, status: "QUEUED" }, testConnection: null } } }; } });
        renderApp("/settings/sheet-sync");
        await screen.findByText("In progress");
        await waitFor(() => expect(polls).toBeGreaterThan(1), { timeout: 7_000 });
    }, 10_000);
});

describe("Google Sheet Sync: automatic vs manual sync", () => {
    // 18:00:04 and 18:07 in Colombo (UTC+05:30) for the scheduled runs, 13:45 for Sync Now.
    const SCHEDULED: SheetSyncRun = { ...RUN, trigger: "SCHEDULER", dryRun: false, createdAt: "2026-10-11T12:30:00.000Z", startedAt: "2026-10-11T12:30:01.000Z", finishedAt: "2026-10-11T12:30:04.000Z", summary: { appended: 0, updated: 1, unchanged: 6 } };
    const MANUAL: SheetSyncRun = { ...RUN, trigger: "ADMIN", dryRun: false, createdAt: "2026-10-12T08:14:55.000Z", startedAt: "2026-10-12T08:14:56.000Z", finishedAt: "2026-10-12T08:15:00.000Z", summary: { appended: 0, updated: 1, unchanged: 6 } };
    const LATER_SCHEDULED: SheetSyncRun = { ...SCHEDULED, runId: "00000000-0000-4000-8000-000000000009", finishedAt: "2026-10-12T12:37:00.000Z" };
    const fact = (label: string) => within(screen.getByText(label, { selector: "dt" }).parentElement!);
    const open = async (status: Partial<SheetSyncStatus>) => {
        signedInBackend({ [`GET ${STATUS_PATH}`]: { status: 200, body: { ...STATUS, ...status } } });
        renderApp("/settings/sheet-sync");
        await screen.findByText("Sync activity");
    };

    test("16. never run: Not yet run for each, no failures, and the automatic schedule is shown", async () => {
        await open({ lastReconciliation: null, lastSuccessfulReconciliation: null, lastAutomaticSync: null, lastManualSync: null, schedule: { times: ["06:00", "12:00", "18:00"], timeZone: "Asia/Colombo" } });
        expect(fact("Last automatic sync").getByText("Not yet run")).toBeInTheDocument();
        expect(fact("Last manual sync").getByText("Not yet run")).toBeInTheDocument();
        expect(fact("Latest sync").getByText("Not yet run")).toBeInTheDocument();
        expect(screen.getByText("No recent failures")).toBeInTheDocument();
        expect(screen.getByText("06:00 · 12:00 · 18:00")).toBeInTheDocument();
        expect(screen.getByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").includes("(Asia/Colombo)"))).toBeInTheDocument();
    });

    test("12-14, 17-18. a scheduled run is the last automatic sync (Colombo time, Scheduled); a later Sync Now is the last manual sync (Manual) and does not replace it", async () => {
        await open({ lastAutomaticSync: SCHEDULED, lastManualSync: MANUAL, lastSuccessfulReconciliation: MANUAL, lastReconciliation: MANUAL });
        expect(fact("Last automatic sync").getByText(/11 Oct 2026.*18:00/)).toBeInTheDocument();
        expect(fact("Last automatic sync").getByText("Scheduled")).toBeInTheDocument();
        expect(fact("Last automatic sync").queryByText(/13:45/)).toBeNull();
        expect(fact("Last manual sync").getByText(/12 Oct 2026.*13:45/)).toBeInTheDocument();
        expect(fact("Last manual sync").getByText("Manual")).toBeInTheDocument();
        // The latest sync is the manual one, and says so.
        expect(fact("Latest sync").getByText(/12 Oct 2026.*13:45/)).toBeInTheDocument();
        expect(fact("Latest sync").getByText("Manual")).toBeInTheDocument();
    });

    test("15. a later scheduled run is the new last automatic sync (a late run is still Scheduled); the manual one stays", async () => {
        await open({ lastAutomaticSync: LATER_SCHEDULED, lastManualSync: MANUAL, lastSuccessfulReconciliation: LATER_SCHEDULED, lastReconciliation: LATER_SCHEDULED });
        expect(fact("Last automatic sync").getByText(/12 Oct 2026.*18:07/)).toBeInTheDocument();
        expect(fact("Last automatic sync").getByText("Scheduled")).toBeInTheDocument();
        expect(fact("Last manual sync").getByText(/12 Oct 2026.*13:45/)).toBeInTheDocument();
        expect(fact("Latest sync").getByText("Scheduled")).toBeInTheDocument();
    });

    test("the operator command counts as manual; a dry run is marked", async () => {
        await open({ lastManualSync: { ...MANUAL, trigger: "OPERATOR", dryRun: true }, lastAutomaticSync: null });
        expect(fact("Last manual sync").getByText("Manual")).toBeInTheDocument();
        expect(fact("Last manual sync").getByText("dry run")).toBeInTheDocument();
        expect(fact("Last automatic sync").getByText("Not yet run")).toBeInTheDocument();
    });

    test("8-11, 19. grouped sections keep every value: status, target, pending / failed, last reconciliation with its source and summary, last failure", async () => {
        await open({
            lastReconciliation: SCHEDULED, lastAutomaticSync: SCHEDULED, lastSuccessfulReconciliation: SCHEDULED,
            integration: { state: "CONFIG_ERROR", lastErrorClass: "SCHEMA_INVALID", lastErrorCode: "MISSING:TEST DATE", lastErrorAt: "2026-10-12T03:00:00.000Z" },
        });
        const summary = within(screen.getByLabelText("Status summary"));
        expect(summary.getByText("Connected · schema valid")).toBeInTheDocument();
        expect(summary.getByText("Configuration error: sync halted")).toBeInTheDocument();
        expect(summary.getByText("Disabled")).toBeInTheDocument();
        expect(fact("Spreadsheet").getByText("…JirMpE / Emlynk Candidate Operational Mirror")).toHaveClass("break-words");
        expect(fact("Pending / failed candidate syncs").getByText("3 / 1")).toBeInTheDocument();
        expect(screen.getByText("0 appended · 1 updated · 6 unchanged")).toBeInTheDocument();
        const lastRun = screen.getByText("Last reconciliation").closest("section")!;
        expect(within(lastRun).getByText("Succeeded")).toBeInTheDocument();
        expect(within(lastRun).getByText("Scheduled")).toBeInTheDocument();
        expect(screen.getByText((text) => text.startsWith("Schema invalid (MISSING:TEST DATE) · 12 Oct 2026"))).toBeInTheDocument();
        expect(screen.queryByText("No recent failures")).toBeNull();
    });
});

describe("Google Sheet Sync: Sync Destination", () => {
    const OPS = { key: "operational", name: "Emlynk Candidate Operational Mirror", hint: "…JirMpE", tabName: "Emlynk Candidate Operational Mirror" };
    const RO = { key: "romania", name: "Romania Candidates", hint: "…Ro1234", tabName: "Romania" };
    const withDestination = (destination: SheetSyncStatus["destination"], extra: Partial<SheetSyncStatus> = {}) => ({ ...STATUS, destination, ...extra });
    const section = () => within(screen.getByText("Sync destination").closest("section")!);
    const open = async (body: SheetSyncStatus, routes: FetchRoutes = {}) => {
        const backend = signedInBackend({ [`GET ${STATUS_PATH}`]: { status: 200, body }, ...routes });
        renderApp("/settings/sheet-sync");
        await screen.findByText("Sync destination");
        return backend;
    };

    test("1-4, 13. renders the configured destinations only, the active one selected and described; the rest of the tab is intact", async () => {
        await open(withDestination({ available: [OPS, RO], activeKey: "operational", requestedKey: null, lastSwitch: null }));
        const select = section().getByRole("combobox", { name: "Google Sheet" });
        expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Emlynk Candidate Operational Mirror", "Romania Candidates"]);
        expect(select).toHaveValue("operational");
        expect(within(screen.getByText("Currently syncing to").parentElement!).getByText("Emlynk Candidate Operational Mirror")).toBeInTheDocument();
        expect(section().getByText("…JirMpE")).toBeInTheDocument();
        expect(within(screen.getByText("Tab", { selector: "dt" }).parentElement!).getByText("Emlynk Candidate Operational Mirror")).toBeInTheDocument();
        expect(section().queryByRole("button", { name: "Use this destination" })).toBeNull();
        // The other groups and actions are still there; no separate Target group.
        for (const title of ["Sync activity", "Last reconciliation", "Last failure"]) expect(screen.getByText(title)).toBeInTheDocument();
        expect(screen.queryByText("Target", { selector: "h3" })).toBeNull();
        expect(screen.getByRole("button", { name: "Test Connection" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Sync Now" })).toBeEnabled();
    });

    test("the current deployment: one destination, selected, nothing else offered", async () => {
        await open(withDestination({ available: [{ ...OPS, key: "default" }], activeKey: "default", requestedKey: null, lastSwitch: null }));
        const select = section().getByRole("combobox", { name: "Google Sheet" });
        expect(within(select).getAllByRole("option")).toHaveLength(1);
        expect(select).toHaveValue("default");
        expect(section().queryByRole("button", { name: "Use this destination" })).toBeNull();
    });

    test("5-6. choosing another destination asks the server to switch (PUT); the page then shows the pending check", async () => {
        let pending = false;
        const { calls } = signedInBackend({
            [`GET ${STATUS_PATH}`]: () => ({
                status: 200,
                body: withDestination({ available: [OPS, RO], activeKey: "operational", requestedKey: pending ? "romania" : null, lastSwitch: null }),
            }),
            "PUT /api/admin/settings/sheet-sync/destination": () => { pending = true; return { status: 202, body: { status: "PENDING", activeKey: "operational", requestedKey: "romania", run: null } }; },
        });
        renderApp("/settings/sheet-sync");
        const user = userEvent.setup();
        await user.selectOptions(await screen.findByRole("combobox", { name: "Google Sheet" }), "romania");
        await user.click(section().getByRole("button", { name: "Use this destination" }));
        expect(await screen.findByText(/Checking access and headers of Romania Candidates\. It becomes the destination once the check passes\./)).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "PUT").map((c) => [c.path, c.body])).toEqual([["/api/admin/settings/sheet-sync/destination", { key: "romania" }]]);
        expect(await screen.findByText(/Emlynk Candidate Operational Mirror stays the destination until the check passes/)).toBeInTheDocument();
        expect(within(screen.getByText("Currently syncing to").parentElement!).getByText("Emlynk Candidate Operational Mirror")).toBeInTheDocument();
        expect(screen.getByRole("combobox", { name: "Google Sheet" })).toBeDisabled();
    });

    test("12. a failed switch is shown plainly; the previous destination is still the one syncing", async () => {
        const lastSwitch = { ...RUN, kind: "TEST_CONNECTION" as const, status: "FAILED" as const, dryRun: null, errorClass: "SCHEMA_INVALID", errorCode: "MISSING:PASSPORT NUMBER", destinationKey: "romania", summary: { purpose: "DESTINATION_SWITCH" } };
        await open(withDestination({ available: [OPS, RO], activeKey: "operational", requestedKey: null, lastSwitch }));
        expect(screen.getByText(/Could not switch to Romania Candidates: Schema invalid \(MISSING:PASSPORT NUMBER\).*Still syncing to Emlynk Candidate Operational Mirror\./)).toBeInTheDocument();
        expect(section().getByRole("combobox", { name: "Google Sheet" })).toHaveValue("operational");
    });

    test("a refused request shows the server's message and changes nothing", async () => {
        await open(withDestination({ available: [OPS, RO], activeKey: "operational", requestedKey: null, lastSwitch: null }), {
            "PUT /api/admin/settings/sheet-sync/destination": { status: 409, body: { message: "A connection test is running. Try again when it has finished.", code: "TEST_RUNNING" } },
        });
        const user = userEvent.setup();
        await user.selectOptions(section().getByRole("combobox", { name: "Google Sheet" }), "romania");
        await user.click(section().getByRole("button", { name: "Use this destination" }));
        expect(await screen.findByText("A connection test is running. Try again when it has finished.")).toBeInTheDocument();
        expect(within(screen.getByText("Currently syncing to").parentElement!).getByText("Emlynk Candidate Operational Mirror")).toBeInTheDocument();
    });

    test("an older server without destination data: the target is shown as before", async () => {
        await open(STATUS);
        expect(within(screen.getByText("Spreadsheet", { selector: "dt" }).parentElement!).getByText("…JirMpE / Emlynk Candidate Operational Mirror")).toBeInTheDocument();
        expect(screen.queryByRole("combobox", { name: "Google Sheet" })).toBeNull();
    });
});
