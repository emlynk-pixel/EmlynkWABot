import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { ADMIN, renderApp, signedInBackend } from "./helpers";

const INVITATIONS = [
    {
        invitationId: "inv-1",
        email: "priyantha@example.invalid",
        name: "Priyantha Silva",
        role: "ANALYST",
        status: "PENDING",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        acceptedAt: null,
        revokedAt: null,
        invitedBy: "admin-1",
    },
    {
        invitationId: "inv-2",
        email: "dilshan@example.invalid",
        name: "Dilshan Perera",
        role: "VIEWER",
        status: "ACCEPTED",
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        createdAt: new Date(Date.now() - 86400000).toISOString(),
        acceptedAt: new Date().toISOString(),
        revokedAt: null,
        invitedBy: "admin-1",
    },
];

describe("Admin Invitations Page", () => {
    test("renders invitation form and list for ADMIN role", async () => {
        signedInBackend({
            "GET /api/admin/invitations": { status: 200, body: { invitations: INVITATIONS } },
        });

        renderApp("/invitations");

        expect(await screen.findByRole("heading", { name: "Admin Invitations" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Invite New Administrator" })).toBeInTheDocument();
        expect(screen.getByLabelText("Full Name")).toBeInTheDocument();
        expect(screen.getByLabelText("Email Address")).toBeInTheDocument();
        expect(screen.getByLabelText("Assigned Role")).toBeInTheDocument();

        // Invitations list
        expect(await screen.findByText("Priyantha Silva")).toBeInTheDocument();
        expect(screen.getByText("priyantha@example.invalid")).toBeInTheDocument();
        expect(screen.getByText("Dilshan Perera")).toBeInTheDocument();
        expect(screen.getByText("Pending Setup")).toBeInTheDocument();
        expect(screen.getByText("Active")).toBeInTheDocument();
    });

    test("submitting the form sends POST /api/admin/invitations and shows success message", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/invitations": { status: 200, body: { invitations: [] } },
            "POST /api/admin/invitations": {
                status: 201,
                body: {
                    message: "Invitation sent successfully",
                    invitation: {
                        invitationId: "inv-new",
                        email: "newcolleague@example.invalid",
                        name: "New Colleague",
                        role: "ANALYST",
                        status: "PENDING",
                        expiresAt: new Date(Date.now() + 86400000).toISOString(),
                        createdAt: new Date().toISOString(),
                    },
                },
            },
        });

        renderApp("/invitations");
        await screen.findByRole("heading", { name: "Admin Invitations" });

        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Full Name"), "New Colleague");
        await user.type(screen.getByLabelText("Email Address"), "newcolleague@example.invalid");
        await user.click(screen.getByRole("button", { name: /Send Invitation/i }));

        expect(await screen.findByText(/Invitation Dispatched/i)).toBeInTheDocument();
        expect(screen.getByText(/Invitation sent to newcolleague@example.invalid/i)).toBeInTheDocument();

        const postCall = calls.find((c) => c.method === "POST" && c.path === "/api/admin/invitations");
        expect(postCall).toBeDefined();
        expect(postCall?.body).toEqual({
            name: "New Colleague",
            email: "newcolleague@example.invalid",
            role: "ANALYST",
        });
    });

    test("non-ADMIN role sees access restricted message", async () => {
        signedInBackend({
            "GET /auth/me": { status: 200, body: { admin: { ...ADMIN, role: "ANALYST" } } },
        });

        renderApp("/invitations");

        expect(await screen.findByText("Access Restricted")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Send Invitation/i })).not.toBeInTheDocument();
    });
});
