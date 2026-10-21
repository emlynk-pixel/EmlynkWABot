import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router";
import { describe, expect, test } from "vitest";
import { AppRoutes } from "../App";
import { AuthProvider } from "../auth/AuthProvider";
import { ADMIN, renderApp, signedInBackend, userWithRole } from "./helpers";

// Settings tabs: Change Roles | Invite User | Google Sheet Sync (no
// Configurations tab; /settings opens Change Roles). Invite User and Change Roles moved here from the sidebar; their
// pages are reused unchanged (their own behaviour is in invitations.test.tsx
// and the Sheet Sync section's in settings.test.tsx). Synthetic data only.

const USERS = [
    { userId: "admin-1", name: "Test Admin", email: ADMIN.email, role: "ADMIN", status: "ACTIVE", createdDate: "2026-10-01T00:00:00.000Z" },
    { userId: "u-2", name: "Ann Analyst", email: "ann@example.invalid", role: "ANALYST", status: "ACTIVE", createdDate: "2026-10-02T00:00:00.000Z" },
];
const STATUS = {
    worker: { online: true, lastHeartbeatAt: "2026-10-06T09:00:00.000Z" }, configured: true, writeGate: "DISABLED", target: "…JirMpE / Mirror",
    integration: { state: "OK", lastErrorClass: null, lastErrorCode: null, lastErrorAt: null }, queue: { pending: 0, processing: 0, failed: 0 },
    lastSuccessfulSyncAt: null, lastReconciliation: null, lastSuccessfulReconciliationAt: null, lastConnectionTest: null,
    activeRuns: { reconcile: null, testConnection: null },
};
const routes = { "GET /api/admin/users": { status: 200, body: { users: USERS } }, "GET /api/admin/settings/sheet-sync/status": { status: 200, body: STATUS } };

const tabs = () => within(screen.getByRole("navigation", { name: "Settings sections" }));
const tabLabels = () => tabs().getAllByRole("link").map((l) => l.textContent);
const activeTab = () => tabs().getAllByRole("link").find((l) => l.getAttribute("aria-current") === "page")?.textContent;
const sidebar = () => within(screen.getByRole("navigation", { name: "Main navigation" }));

describe("Settings tabs", () => {
    test("1-5, 17. the sidebar has Settings but no Invite User / Change Roles; Settings shows four tabs (no Configurations) and opens Change Roles; one page title", async () => {
        signedInBackend(routes);
        renderApp("/settings");
        expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeInTheDocument();
        expect(await screen.findByRole("heading", { name: "Change Roles", level: 2 })).toBeInTheDocument();
        expect(sidebar().getByRole("link", { name: "Settings" })).toBeInTheDocument();
        expect(sidebar().queryByRole("link", { name: "Invite User" })).toBeNull();
        expect(sidebar().queryByRole("link", { name: "Change Roles" })).toBeNull();
        expect(sidebar().getByRole("link", { name: "Audit Logs" })).toBeInTheDocument();
        expect(tabLabels()).toEqual(["Change Roles", "Invite User", "Google Sheet Sync", "Job Types"]);
        expect(screen.queryByRole("link", { name: "Configurations" })).toBeNull();
        expect(screen.queryByText(/configuration options/i)).toBeNull();
        expect(activeTab()).toBe("Change Roles");
        expect(sidebar().getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
        expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    });

    test("5, 8, 17. Change Roles tab: the existing role list and role change (PUT, confirmation, success); one page title", async () => {
        const { calls } = signedInBackend({ ...routes, "PUT /api/admin/users/u-2/role": { status: 200, body: { user: { ...USERS[1], role: "MANAGER" } } } });
        renderApp("/settings/invite");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("link", { name: "Change Roles" }));
        expect(await screen.findByRole("heading", { name: "Change Roles", level: 2 })).toBeInTheDocument();
        expect(activeTab()).toBe("Change Roles");
        expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Settings"]);
        await user.selectOptions(await screen.findByRole("combobox", { name: "Change role for Ann Analyst" }), "MANAGER");
        const dialog = await screen.findByRole("dialog", { name: "Confirm Role Change" });
        await user.click(within(dialog).getByRole("button", { name: "Confirm Change" }));
        expect(await screen.findByText("Role updated successfully.")).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "PUT").map((c) => [c.path, c.body])).toEqual([["/api/admin/users/u-2/role", { role: "MANAGER" }]]);
        expect(screen.getByRole("combobox", { name: "Change role for Test Admin" })).toBeDisabled();
    });

    test("6, 9. Invite User tab: the existing invite form sends the same request", async () => {
        const { calls } = signedInBackend({
            ...routes,
            "POST /api/admin/users/invite": { status: 201, body: { outcome: "INVITED", user: { ...USERS[1], userId: "u-9", email: "new@example.invalid", role: "REGISTRATION_DESK", status: "INVITED" } } },
        });
        renderApp("/settings");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("link", { name: "Invite User" }));
        expect(await screen.findByRole("heading", { name: "Invite User", level: 2 })).toBeInTheDocument();
        expect(activeTab()).toBe("Invite User");
        expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
        await user.type(await screen.findByLabelText("Full Name"), "New Colleague");
        await user.type(screen.getByLabelText("Email Address"), "new@example.invalid");
        await user.selectOptions(screen.getByRole("combobox", { name: /^Role/ }), "REGISTRATION_DESK");
        await user.click(screen.getByRole("button", { name: /Send Invitation/ }));
        expect(await screen.findByText(/Invitation sent to new@example.invalid/)).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([
            ["/api/admin/users/invite", { name: "New Colleague", email: "new@example.invalid", role: "REGISTRATION_DESK" }],
        ]);
    });

    test("7, 10. Google Sheet Sync tab: the existing section, its status and its actions", async () => {
        const { calls } = signedInBackend({ ...routes, "POST /api/admin/settings/sheet-sync/run": { status: 202, body: { run: {}, alreadyActive: false } } });
        renderApp("/settings");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("link", { name: "Google Sheet Sync" }));
        expect(await screen.findByRole("heading", { name: "Google Sheet Sync" })).toBeInTheDocument();
        expect(activeTab()).toBe("Google Sheet Sync");
        expect(await screen.findByText("…JirMpE / Mirror")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Test Connection" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Sync Now" }));
        expect(await screen.findByText(/Sync requested/)).toBeInTheDocument();
        expect(calls.some((c) => c.method === "POST" && c.path === "/api/admin/settings/sheet-sync/run")).toBe(true);
    });

    test("Sheet Sync data is requested only on its own tab", async () => {
        const { calls } = signedInBackend(routes);
        renderApp("/settings");
        await screen.findByRole("heading", { name: "Change Roles", level: 2 });
        expect(calls.some((c) => c.path.startsWith("/api/admin/settings"))).toBe(false);
    });

    test("16. each tab has its own URL: opening it directly (a reload) shows that tab", async () => {
        for (const [path, tab, heading] of [
            ["/settings/roles", "Change Roles", "Change Roles"],
            ["/settings/invite", "Invite User", "Invite User"],
            ["/settings/sheet-sync", "Google Sheet Sync", "Google Sheet Sync"],
        ] as const) {
            signedInBackend(routes);
            const { unmount } = renderApp(path);
            expect(await screen.findByRole("heading", { name: heading, level: 2 })).toBeInTheDocument();
            expect(activeTab()).toBe(tab);
            expect(sidebar().getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
            expect(within(screen.getByRole("navigation", { name: /breadcrumb/i })).getByText("Settings")).toBeInTheDocument();
            unmount();
        }
    });

    test("13-14. the old /invitations and /roles URLs open the matching Settings tab", async () => {
        signedInBackend(routes);
        const first = renderApp("/invitations");
        expect(await screen.findByRole("heading", { name: "Invite User", level: 2 })).toBeInTheDocument();
        expect(activeTab()).toBe("Invite User");
        first.unmount();

        signedInBackend(routes);
        renderApp("/roles");
        expect(await screen.findByRole("heading", { name: "Change Roles", level: 2 })).toBeInTheDocument();
        expect(activeTab()).toBe("Change Roles");
    });

    test("15. Back and Forward move between tabs", async () => {
        signedInBackend(routes);
        function HistoryButtons() {
            const navigate = useNavigate();
            return (
                <>
                    <button type="button" onClick={() => navigate(-1)}>test-back</button>
                    <button type="button" onClick={() => navigate(1)}>test-forward</button>
                </>
            );
        }
        render(
            <MemoryRouter initialEntries={["/settings"]}>
                <AuthProvider>
                    <AppRoutes />
                    <HistoryButtons />
                </AuthProvider>
            </MemoryRouter>,
        );
        const user = userEvent.setup();
        // /settings opened Change Roles (replacing the entry, so Back doesn't land on /settings).
        await screen.findByRole("heading", { name: "Change Roles", level: 2 });
        await user.click(screen.getByRole("link", { name: "Invite User" }));
        await screen.findByRole("heading", { name: "Invite User", level: 2 });
        await user.click(screen.getByRole("link", { name: "Google Sheet Sync" }));
        await screen.findByRole("heading", { name: "Google Sheet Sync" });

        await user.click(screen.getByRole("button", { name: "test-back" }));
        expect(await screen.findByRole("heading", { name: "Invite User", level: 2 })).toBeInTheDocument();
        expect(activeTab()).toBe("Invite User");
        await user.click(screen.getByRole("button", { name: "test-back" }));
        expect(await screen.findByRole("heading", { name: "Change Roles", level: 2 })).toBeInTheDocument();
        expect(activeTab()).toBe("Change Roles");
        await user.click(screen.getByRole("button", { name: "test-forward" }));
        expect(await screen.findByRole("heading", { name: "Invite User", level: 2 })).toBeInTheDocument();
    });

    for (const role of ["MANAGER", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]) {
        test(`11-12. ${role}: no Settings or Change Roles in the sidebar; every Settings URL shows Access Restricted and requests nothing`, async () => {
            // A MANAGER's /invitations is its Job Handler invitation page (invitations.test.tsx), not a Settings URL.
            const paths = ["/settings", "/settings/roles", "/settings/invite", "/settings/sheet-sync", "/roles", ...(role === "MANAGER" ? [] : ["/invitations"])];
            for (const path of paths) {
                const { calls } = signedInBackend({ ...routes, "GET /auth/me": { status: 200, body: { user: userWithRole(role) } } });
                const { unmount } = renderApp(path);
                expect(await screen.findByRole("heading", { name: "Access Restricted" })).toBeInTheDocument();
                for (const name of ["Settings", "Change Roles"]) expect(sidebar().queryByRole("link", { name })).toBeNull();
                if (role === "MANAGER") expect(sidebar().getByRole("link", { name: "Invite User" })).toHaveAttribute("href", "/invitations");
                else expect(sidebar().queryByRole("link", { name: "Invite User" })).toBeNull();
                expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
                expect(screen.queryByRole("combobox", { name: /Change role for/ })).toBeNull();
                expect(screen.queryByLabelText("Email Address")).toBeNull();
                expect(calls.some((c) => c.path.startsWith("/api/admin/users") || c.path.startsWith("/api/admin/settings")), path).toBe(false);
                unmount();
            }
        });
    }
});
