import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { ALL_ROLES, ROLES, assignableRoles, canManageUser, canRenameUser, hasRole, invitableRoles, isAdmin, roleLabel, ADMIN_ONLY, DASHBOARD_ROLES, MASTER_DATA_ROLES } from "../auth/roles";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, userWithRole } from "./helpers";

// The OWNER role in the admin app: every ADMIN page, plus managing Admin accounts. Nobody gives the
// Owner role or changes an Owner account here (the Owner is set in the database only). An ADMIN
// sees the Owner and the other Admins but has no control over them. The backend
// enforces all of it (test/ownerRole.test.js); this only checks what the screens offer.
// Synthetic data only.

const OWNER = userWithRole("OWNER");
const account = (userId: string, name: string, role: string, status = "ACTIVE") => ({ userId, name, email: `${userId}@example.invalid`, role, status, createdDate: "2026-10-01T00:00:00.000Z" });
// The signed-in user is ADMIN.userId ("admin-1") with the role the test gives it.
const USERS = [
    account(ADMIN.userId, "Test User", "ADMIN"),
    account("owner-2", "Olga Owner", "OWNER"),
    account("admin-2", "Adam Admin", "ADMIN", "INACTIVE"),
    account("desk-1", "Dee Desk", "REGISTRATION_DESK"),
    account("analyst-1", "Ann Analyst", "ANALYST", "INACTIVE"),
];
const as = (role: string, routes: Parameters<typeof signedInBackend>[0] = {}) => {
    const me = { ...userWithRole(role) };
    const users = USERS.map((u) => (u.userId === me.userId ? { ...u, role } : u));
    return signedInBackend({ "GET /auth/me": { status: 200, body: { user: me } }, "GET /api/admin/users": { status: 200, body: { users } }, ...routes });
};
const rowOf = async (name: string) => (await screen.findByText(name, {}, RENDER_STEP)).closest("tr") as HTMLElement;
const optionsOf = (select: HTMLElement) => within(select).getAllByRole("option").map((o) => o.getAttribute("value"));

describe("roles.ts", () => {
    test("OWNER passes every list that admits ADMIN, and no other", () => {
        expect(hasRole(OWNER, ADMIN_ONLY)).toBe(true);
        expect(hasRole(OWNER, DASHBOARD_ROLES)).toBe(true);
        expect(hasRole(OWNER, MASTER_DATA_ROLES)).toBe(true);
        expect(hasRole(OWNER, [ROLES.ANALYST])).toBe(false);
        expect(isAdmin(OWNER)).toBe(true);
        expect(hasRole(userWithRole("ADMIN"), [ROLES.OWNER])).toBe(false);
    });

    test("what each role may invite and give", () => {
        expect(invitableRoles(OWNER)).toEqual(["ADMIN", "TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        expect(invitableRoles(userWithRole("ADMIN"))).toEqual(["TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        expect(assignableRoles(OWNER)).toEqual(["ADMIN", "TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        expect(assignableRoles(userWithRole("ADMIN"))).toEqual(["TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        // A retired MANAGER account (not converted yet) gives and invites nothing.
        for (const role of ["MANAGER", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]) {
            expect(invitableRoles(userWithRole(role))).toEqual([]);
            expect(assignableRoles(userWithRole(role))).toEqual([]);
            expect(invitableRoles(userWithRole(role)).includes(ROLES.ADMIN)).toBe(false);
        }
    });

    test("MANAGER is retired: not a role, in no list; it reads as such where history still names it", () => {
        expect(ALL_ROLES).toEqual(["OWNER", "ADMIN", "TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        expect(Object.values(ROLES)).not.toContain("MANAGER");
        for (const list of [ADMIN_ONLY, DASHBOARD_ROLES, MASTER_DATA_ROLES]) expect(list as readonly string[]).not.toContain("MANAGER");
        expect(isAdmin(userWithRole("MANAGER"))).toBe(false);
        expect(roleLabel("MANAGER")).toBe("Manager (retired)");
        expect(roleLabel("ANALYST")).toBe("Analyst");
    });

    test("who may change whom: never yourself, never an Owner; an ADMIN never an Admin", () => {
        const admin = userWithRole("ADMIN");
        expect(canManageUser(OWNER, { userId: "x", role: "ADMIN" })).toBe(true);
        expect(canManageUser(OWNER, { userId: "x", role: "OWNER" })).toBe(false);
        expect(canManageUser(OWNER, { userId: OWNER.userId, role: "OWNER" })).toBe(false);
        expect(canManageUser(admin, { userId: "x", role: "JOB_HANDLER" })).toBe(true);
        // An account holding the retired MANAGER role: the Owner's to change, not an Admin's.
        expect(canManageUser(OWNER, { userId: "x", role: "MANAGER" })).toBe(true);
        expect(canManageUser(admin, { userId: "x", role: "MANAGER" })).toBe(false);
        expect(canManageUser(admin, { userId: "x", role: "ADMIN" })).toBe(false);
        expect(canManageUser(admin, { userId: "x", role: "OWNER" })).toBe(false);
        expect(canManageUser(userWithRole("MANAGER"), { userId: "x", role: "JOB_HANDLER" })).toBe(false);
    });
});

describe("OWNER in the admin app", () => {
    test("the header names the Owner; the sidebar and Settings are the ADMIN's", async () => {
        as("OWNER");
        renderApp("/settings");
        expect(await screen.findByRole("heading", { name: "Settings", level: 1 }, RENDER_STEP)).toBeInTheDocument();
        // The account card at the foot of the sidebar: the name, then the role.
        expect(screen.getByTestId("admin-name").nextElementSibling).toHaveTextContent("Owner");
        const nav = within(screen.getByRole("navigation", { name: "Main navigation" }));
        for (const name of ["Overview", "Candidates", "Jobs", "Work Allocation", "Audit Logs", "Settings"]) expect(nav.getByRole("link", { name })).toBeInTheDocument();
        expect(nav.queryByRole("link", { name: "Invite User" })).toBeNull();
        const tabs = within(screen.getByRole("navigation", { name: "Settings sections" })).getAllByRole("link").map((l) => l.textContent);
        expect(tabs).toEqual(["Change Roles", "Invite User", "Google Sheet Sync", "Job Types", "Candidate Form"]);
    });

    test("Change Roles: Admin and below for an Admin account, never Owner; Owner and own account locked; the Owner marked", async () => {
        as("OWNER");
        renderApp("/settings/roles");
        const adminSelect = await screen.findByRole("combobox", { name: "Change role for Adam Admin" }, RENDER_STEP);
        expect(adminSelect).toBeEnabled();
        expect(optionsOf(adminSelect)).toEqual(["ADMIN", "TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        const ownerSelect = screen.getByRole("combobox", { name: "Change role for Olga Owner" });
        expect(ownerSelect).toBeDisabled();
        expect(optionsOf(ownerSelect)).toEqual(["OWNER"]);
        expect(screen.getByRole("combobox", { name: "Change role for Test User" })).toBeDisabled();
        expect(within(await rowOf("Olga Owner")).getByText("Owner", { selector: "span" })).toBeInTheDocument();
    });

    test("Invite User: Admin and below, never Owner; re-invite an Admin; no buttons on the Owner's row", async () => {
        as("OWNER");
        renderApp("/settings/invite");
        const select = await screen.findByRole("combobox", { name: /^Role/ }, RENDER_STEP);
        expect(optionsOf(select)).toEqual(["ADMIN", "TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        expect(within(await rowOf("Adam Admin")).getByRole("button", { name: "Re-invite" })).toBeInTheDocument();
        expect(within(await rowOf("Olga Owner")).queryAllByRole("button")).toEqual([]);
    });
});

describe("ADMIN: no control over Admin and Owner accounts", () => {
    test("Change Roles: Admin and Owner rows are locked to their role; others offer only the roles below Admin", async () => {
        as("ADMIN");
        renderApp("/settings/roles");
        const adminSelect = await screen.findByRole("combobox", { name: "Change role for Adam Admin" }, RENDER_STEP);
        expect(adminSelect).toBeDisabled();
        expect(optionsOf(adminSelect)).toEqual(["ADMIN"]);
        const ownerSelect = screen.getByRole("combobox", { name: "Change role for Olga Owner" });
        expect(ownerSelect).toBeDisabled();
        expect(optionsOf(ownerSelect)).toEqual(["OWNER"]);
        const deskSelect = screen.getByRole("combobox", { name: "Change role for Dee Desk" });
        expect(deskSelect).toBeEnabled();
        expect(optionsOf(deskSelect)).toEqual(["TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        expect(screen.getByText(/Admin roles can be changed by an Owner only/)).toBeInTheDocument();
        expect(within(await rowOf("Olga Owner")).getByText("Owner", { selector: "span" })).toBeInTheDocument();
    });

    test("Invite User: no Admin or Owner role; no re-invite or deactivate on Admin and Owner rows; lower rows keep them", async () => {
        as("ADMIN");
        renderApp("/settings/invite");
        const select = await screen.findByRole("combobox", { name: /^Role/ }, RENDER_STEP);
        expect(optionsOf(select)).not.toContain("ADMIN");
        expect(optionsOf(select)).not.toContain("OWNER");
        for (const name of ["Adam Admin", "Olga Owner"]) expect(within(await rowOf(name)).queryAllByRole("button")).toEqual([]);
        expect(within(await rowOf("Dee Desk")).getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
        expect(within(await rowOf("Ann Analyst")).getByRole("button", { name: "Re-invite" })).toBeInTheDocument();
    });
});

describe("names: your own (profile) and other users' (Change Roles)", () => {
    const editButton = (row: HTMLElement) => within(row).queryByRole("button", { name: /^Edit name of / });

    test("canRenameUser: your own always; an Owner or Admin any account but the Owner's; nobody else another's", () => {
        const target = (userId: string, role: string) => ({ userId, role });
        const admin = userWithRole("ADMIN");
        expect(canRenameUser(admin, target(admin.userId, "ADMIN"))).toBe(true);
        expect(canRenameUser(admin, target("admin-2", "ADMIN"))).toBe(true);
        expect(canRenameUser(admin, target("desk-1", "REGISTRATION_DESK"))).toBe(true);
        expect(canRenameUser(admin, target("owner-2", "OWNER"))).toBe(false);
        expect(canRenameUser(OWNER, target("admin-2", "ADMIN"))).toBe(true);
        const analyst = userWithRole("ANALYST");
        expect(canRenameUser(analyst, target(analyst.userId, "ANALYST"))).toBe(true);
        expect(canRenameUser(analyst, target("desk-1", "REGISTRATION_DESK"))).toBe(false);
    });

    test("ADMIN: an Edit name button on every row but the Owner's (another Admin included)", async () => {
        as("ADMIN");
        renderApp("/settings/roles");
        expect(editButton(await rowOf("Olga Owner"))).toBeNull();
        for (const name of ["Adam Admin", "Dee Desk", "Ann Analyst", "Test User"]) expect(editButton(await rowOf(name)), name).not.toBeNull();
    });

    test("OWNER: renames an Admin through user management; the list reloads with a confirmation", async () => {
        const { calls } = as("OWNER", { "PUT /api/admin/users/admin-2/name": { status: 200, body: { user: account("admin-2", "Adam Smith", "ADMIN", "INACTIVE") } } });
        renderApp("/settings/roles");
        const user = userEvent.setup();
        await user.click(editButton(await rowOf("Adam Admin"))!);
        const dialog = await screen.findByRole("dialog", { name: "Edit name of Adam Admin" });
        const input = within(dialog).getByLabelText(/^Name/);
        await user.clear(input);
        await user.type(input, "  Adam   Smith ");
        await user.click(within(dialog).getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ name: "Adam Smith" }));
        expect(calls.find((c) => c.method === "PUT")?.path).toBe("/api/admin/users/admin-2/name");
        expect(await screen.findByText("Name updated.")).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    test("your own row saves through your profile (PUT /auth/me/name) and refreshes the signed-in user", async () => {
        const { calls } = as("ADMIN", { "PUT /auth/me/name": { status: 200, body: { user: { ...userWithRole("ADMIN"), name: "Renamed Me" } } } });
        renderApp("/settings/roles");
        const user = userEvent.setup();
        await user.click(editButton(await rowOf("Test User"))!);
        const dialog = await screen.findByRole("dialog", { name: "Edit your name" });
        await user.clear(within(dialog).getByLabelText(/^Name/));
        await user.type(within(dialog).getByLabelText(/^Name/), "Renamed Me");
        await user.click(within(dialog).getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/auth/me/name")).toBe(true));
        expect(calls.some((c) => c.method === "PUT" && c.path.startsWith("/api/admin/users/"))).toBe(false);
        await vi.waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path === "/auth/me").length).toBeGreaterThan(1));
    });

    test("a server refusal is shown in the dialog and nothing is confirmed", async () => {
        as("ADMIN", { "PUT /api/admin/users/desk-1/name": { status: 403, body: { message: "Insufficient permissions", code: "FORBIDDEN" } } });
        renderApp("/settings/roles");
        const user = userEvent.setup();
        await user.click(editButton(await rowOf("Dee Desk"))!);
        const dialog = await screen.findByRole("dialog");
        await user.type(within(dialog).getByLabelText(/^Name/), " X");
        await user.click(within(dialog).getByRole("button", { name: "Save" }));
        expect(await within(dialog).findByText("Insufficient permissions")).toBeInTheDocument();
        expect(screen.queryByText("Name updated.")).toBeNull();
    });

    test("the profile menu: Edit name for any role; saved through PUT /auth/me/name", async () => {
        const { calls } = as("ANALYST", { "PUT /auth/me/name": { status: 200, body: { user: { ...userWithRole("ANALYST"), name: "New Name" } } } });
        renderApp("/");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: /^Account: / }, RENDER_STEP));
        await user.click(screen.getByRole("button", { name: "Edit name" }));
        const dialog = await screen.findByRole("dialog", { name: "Edit name" });
        const input = within(dialog).getByLabelText(/^Name/);
        expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
        await user.clear(input);
        await user.type(input, "New Name");
        await user.click(within(dialog).getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/auth/me/name")?.body).toEqual({ name: "New Name" }));
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
});
