import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { ADMIN, SESSION_TOKEN, renderApp, signedInBackend, userWithRole } from "./helpers";

const USERS = [
    { userId: "admin-1", name: "Test Admin", email: ADMIN.email, role: "ADMIN", status: "ACTIVE", createdDate: "2026-10-01T00:00:00.000Z" },
    { userId: "u-2", name: "Pending Person", email: "pending@example.invalid", role: "ANALYST", status: "INVITED", createdDate: "2026-10-02T00:00:00.000Z" },
    { userId: "u-3", name: "Former Staff", email: "former@example.invalid", role: "MANAGER", status: "INACTIVE", createdDate: "2026-10-03T00:00:00.000Z" },
];
const list = { status: 200, body: { users: USERS } };

describe("Invite User page", () => {
    test("ADMIN: invite form with all four roles, and the user list with statuses", async () => {
        signedInBackend({ "GET /api/admin/users": list });
        renderApp("/invitations");
        expect(await screen.findByRole("heading", { name: "Invite User" })).toBeInTheDocument();
        const roleOptions = within(screen.getByRole("combobox", { name: /^Role/ })).getAllByRole("option").map((o) => o.getAttribute("value"));
        expect(roleOptions).toEqual(["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"]);
        expect(await screen.findByText("Pending Person")).toBeInTheDocument();
        expect(screen.getByText("Invitation sent")).toBeInTheDocument();
        expect(screen.getByText("Inactive")).toBeInTheDocument();
        expect(screen.queryByText(/VIEWER/i)).not.toBeInTheDocument();
    });

    test("non-ADMIN roles see Access Restricted and request nothing", async () => {
        for (const role of ["MANAGER", "ANALYST", "REGISTRATION_DESK"]) {
            const { calls } = signedInBackend({ "GET /auth/me": { status: 200, body: { user: userWithRole(role) } } });
            const { unmount } = renderApp("/invitations");
            expect(await screen.findByText("Access Restricted")).toBeInTheDocument();
            expect(calls.some((c) => c.path.startsWith("/api/admin/users"))).toBe(false);
            unmount();
        }
    });

    test("sending: POST /api/admin/users/invite with the chosen role and the Supabase session; success message", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/users": list,
            "POST /api/admin/users/invite": { status: 201, body: { outcome: "INVITED", user: { ...USERS[1], userId: "u-9", email: "new@example.invalid", role: "REGISTRATION_DESK" } } },
        });
        renderApp("/invitations");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Full Name"), "New Colleague");
        await user.type(screen.getByLabelText("Email Address"), "new@example.invalid");
        await user.selectOptions(screen.getByRole("combobox", { name: /^Role/ }), "REGISTRATION_DESK");
        await user.click(screen.getByRole("button", { name: /Send Invitation/ }));

        expect(await screen.findByText(/Invitation sent to new@example.invalid/)).toBeInTheDocument();
        const post = calls.find((c) => c.method === "POST");
        expect(post?.path).toBe("/api/admin/users/invite");
        expect(post?.body).toEqual({ name: "New Colleague", email: "new@example.invalid", role: "REGISTRATION_DESK" });
        expect(post?.headers.Authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    });

    test("a reactivated account says so instead of 'invitation sent'", async () => {
        signedInBackend({
            "GET /api/admin/users": list,
            "POST /api/admin/users/invite": { status: 200, body: { outcome: "REACTIVATED", user: { ...USERS[2], status: "ACTIVE" } } },
        });
        renderApp("/invitations");
        await userEvent.setup().click(await screen.findByRole("button", { name: "Re-invite" }));
        expect(await screen.findByText(/already had an account; it is active again as Manager/)).toBeInTheDocument();
    });

    test("the backend's refusal (e.g. already active) is shown", async () => {
        signedInBackend({
            "GET /api/admin/users": list,
            "POST /api/admin/users/invite": { status: 409, body: { message: "An active user with this email already exists.", code: "USER_ALREADY_ACTIVE" } },
        });
        renderApp("/invitations");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Full Name"), "Dup");
        await user.type(screen.getByLabelText("Email Address"), "admin@example.invalid");
        await user.click(screen.getByRole("button", { name: /Send Invitation/ }));
        expect(await screen.findByText("An active user with this email already exists.")).toBeInTheDocument();
    });

    test("pending invitations can be resent or revoked; the signed-in admin can't deactivate themself", async () => {
        vi.spyOn(window, "confirm").mockReturnValue(true);
        const { calls } = signedInBackend({
            "GET /api/admin/users": list,
            "POST /api/admin/users/u-2/deactivate": { status: 200, body: { user: { ...USERS[1], status: "INACTIVE" } } },
        });
        renderApp("/invitations");
        const row = (await screen.findByText("Pending Person")).closest("tr") as HTMLElement;
        expect(within(row).getByRole("button", { name: "Resend invitation" })).toBeInTheDocument();
        await userEvent.setup().click(within(row).getByRole("button", { name: "Revoke invitation" }));
        expect(calls.some((c) => c.method === "POST" && c.path === "/api/admin/users/u-2/deactivate")).toBe(true);

        const selfRow = screen.getByText(ADMIN.email).closest("tr") as HTMLElement;
        expect(within(selfRow).queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    });
});
