import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, test } from "vitest";
import { AppRoutes } from "../App";
import { AuthProvider } from "../auth/AuthProvider";
import { renderApp, stubBackend } from "./helpers";

const INVITATION = {
    invitationId: "inv-abc",
    email: "sarath@example.invalid",
    name: "Sarath Fonseka",
    role: "ANALYST",
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
};

describe("Setup Password Page", () => {
    test("loads token, verifies invitation, and displays invitee name and role", async () => {
        stubBackend({
            "GET /auth/invitation": { status: 200, body: { message: "Invitation valid", invitation: INVITATION } },
        });

        renderApp("/setup-password?token=valid-token-123");

        expect(await screen.findByRole("heading", { name: "Set Your Password" })).toBeInTheDocument();
        expect(screen.getByText("Sarath Fonseka")).toBeInTheDocument();
        expect(screen.getByText("ANALYST")).toBeInTheDocument();
        expect(screen.getByLabelText("Email Address")).toHaveValue("sarath@example.invalid");
    });

    test("successfully sets password and shows activation success card", async () => {
        const { calls } = stubBackend({
            "GET /auth/invitation": { status: 200, body: { message: "Invitation valid", invitation: INVITATION } },
            "POST /auth/setup-password": { status: 200, body: { message: "Password set successfully. Account is now active." } },
        });

        renderApp("/setup-password?token=valid-token-123");
        await screen.findByRole("heading", { name: "Set Your Password" });

        const user = userEvent.setup();
        await user.type(screen.getByLabelText(/^New Password/i), "MySecurePassword123!");
        await user.type(screen.getByLabelText(/^Confirm Password/i), "MySecurePassword123!");
        await user.click(screen.getByRole("button", { name: /Activate Account/i }));

        expect(await screen.findByRole("heading", { name: "Account Activated!" })).toBeInTheDocument();
        expect(screen.getByText(/Your password has been successfully configured/i)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Continue to Sign In" })).toBeInTheDocument();

        const postCall = calls.find((c) => c.method === "POST" && c.path === "/auth/setup-password");
        expect(postCall).toBeDefined();
        expect(postCall?.body).toEqual({
            token: "valid-token-123",
            password: "MySecurePassword123!",
        });
    });

    test("displays error state when token is expired or invalid", async () => {
        stubBackend({
            "GET /auth/invitation": { status: 400, body: { message: "Invitation has expired", code: "EXPIRED" } },
        });

        renderApp("/setup-password?token=expired-token");

        expect(await screen.findByRole("heading", { name: "Invitation Problem" })).toBeInTheDocument();
        expect(screen.getByText("Invitation has expired")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Return to Sign In" })).toBeInTheDocument();
        expect(screen.queryByLabelText(/^New Password/i)).not.toBeInTheDocument();
    });

    test("shows error when passwords do not match", async () => {
        stubBackend({
            "GET /auth/invitation": { status: 200, body: { message: "Invitation valid", invitation: INVITATION } },
        });

        renderApp("/setup-password?token=valid-token-123");
        await screen.findByRole("heading", { name: "Set Your Password" });

        const user = userEvent.setup();
        await user.type(screen.getByLabelText(/^New Password/i), "PasswordA123!");
        await user.type(screen.getByLabelText(/^Confirm Password/i), "PasswordB456!");
        await user.click(screen.getByRole("button", { name: /Activate Account/i }));

        expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
    });

    // The emailed link opened in a fresh tab: the full /admin/... path through
    // the same basename as main.tsx, with nobody signed in.
    test("the emailed /admin/setup-password link opens the setup page for a signed-out visitor", async () => {
        const { calls } = stubBackend({
            "GET /auth/me": { status: 401, body: { message: "Authentication Token is required!" } },
            "GET /auth/invitation": { status: 200, body: { message: "Invitation valid", invitation: INVITATION } },
        });

        render(
            <MemoryRouter basename="/admin" initialEntries={[`/admin/setup-password?token=${"f".repeat(64)}`]}>
                <AuthProvider>
                    <AppRoutes />
                </AuthProvider>
            </MemoryRouter>
        );

        expect(await screen.findByRole("heading", { name: "Set Your Password" })).toBeInTheDocument();
        expect(calls.some((c) => c.path === `/auth/invitation?token=${"f".repeat(64)}`)).toBe(true);
    });
});
