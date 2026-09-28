import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { renderApp, stubBackend } from "./helpers";

describe("Forgot Password Flow", () => {
    test("login page renders 'Forgot password?' link leading to /forgot-password", async () => {
        stubBackend({});
        renderApp("/login");

        const link = await screen.findByRole("link", { name: "Forgot password?" });
        expect(link).toBeInTheDocument();
        expect(link.getAttribute("href")).toBe("/forgot-password");
    });

    test("submitting forgot password form sends POST /auth/forgot-password and shows confirmation", async () => {
        const { calls } = stubBackend({
            "POST /auth/forgot-password": {
                status: 200,
                body: { message: "If the account exists, a password reset link has been sent." },
            },
        });

        renderApp("/forgot-password");
        expect(await screen.findByRole("heading", { name: "Reset password" })).toBeInTheDocument();

        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Email"), "admin@example.invalid");
        await user.click(screen.getByRole("button", { name: "Send reset link" }));

        expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
        expect(screen.getByText(/If an active account matches that email address/i)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Return to sign in" })).toBeInTheDocument();

        const postCall = calls.find((c) => c.method === "POST" && c.path === "/auth/forgot-password");
        expect(postCall).toBeDefined();
        expect(postCall?.body).toEqual({ email: "admin@example.invalid" });
    });

    test("forgot password shows error if submitted without email", async () => {
        stubBackend({});
        renderApp("/forgot-password");
        await screen.findByRole("heading", { name: "Reset password" });

        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Send reset link" }));

        expect(await screen.findByText("Enter your email address.")).toBeInTheDocument();
    });
});

describe("Reset Password Flow", () => {
    test("validates token and displays new password inputs", async () => {
        stubBackend({
            "GET /auth/reset-password": {
                status: 200,
                body: { valid: true, message: "Reset token is valid" },
            },
        });

        renderApp("/reset-password?token=valid-token-xyz");

        expect(await screen.findByRole("heading", { name: "Set New Password" })).toBeInTheDocument();
        expect(screen.getByLabelText("New Password")).toBeInTheDocument();
        expect(screen.getByLabelText("Confirm Password")).toBeInTheDocument();
    });

    test("displays error state when token is invalid or expired", async () => {
        stubBackend({
            "GET /auth/reset-password": {
                status: 400,
                body: { message: "Password reset link has expired", code: "EXPIRED" },
            },
        });

        renderApp("/reset-password?token=expired-token-xyz");

        expect(await screen.findByRole("heading", { name: "Reset Link Problem" })).toBeInTheDocument();
        expect(screen.getByText("Password reset link has expired")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Request New Reset Link" })).toBeInTheDocument();
        expect(screen.queryByLabelText("New Password")).not.toBeInTheDocument();
    });

    test("shows validation error when passwords do not match", async () => {
        stubBackend({
            "GET /auth/reset-password": {
                status: 200,
                body: { valid: true, message: "Reset token is valid" },
            },
        });

        renderApp("/reset-password?token=valid-token-xyz");
        await screen.findByRole("heading", { name: "Set New Password" });

        const user = userEvent.setup();
        await user.type(screen.getByLabelText("New Password"), "SuperPassword123!");
        await user.type(screen.getByLabelText("Confirm Password"), "DifferentPassword456!");
        await user.click(screen.getByRole("button", { name: "Reset password" }));

        expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
    });

    test("shows validation error when password is under 8 characters", async () => {
        stubBackend({
            "GET /auth/reset-password": {
                status: 200,
                body: { valid: true, message: "Reset token is valid" },
            },
        });

        renderApp("/reset-password?token=valid-token-xyz");
        await screen.findByRole("heading", { name: "Set New Password" });

        const user = userEvent.setup();
        await user.type(screen.getByLabelText("New Password"), "short");
        await user.type(screen.getByLabelText("Confirm Password"), "short");
        await user.click(screen.getByRole("button", { name: "Reset password" }));

        expect(await screen.findByText("Password must be at least 8 characters long.")).toBeInTheDocument();
    });

    test("submitting valid passwords sends POST /auth/reset-password and displays success state", async () => {
        const { calls } = stubBackend({
            "GET /auth/reset-password": {
                status: 200,
                body: { valid: true, message: "Reset token is valid" },
            },
            "POST /auth/reset-password": {
                status: 200,
                body: { message: "Password reset successful. You can now sign in with your new password." },
            },
        });

        renderApp("/reset-password?token=valid-token-xyz");
        await screen.findByRole("heading", { name: "Set New Password" });

        const user = userEvent.setup();
        await user.type(screen.getByLabelText("New Password"), "NewAwesomePassword123!");
        await user.type(screen.getByLabelText("Confirm Password"), "NewAwesomePassword123!");
        await user.click(screen.getByRole("button", { name: "Reset password" }));

        expect(await screen.findByRole("heading", { name: "Password Reset Complete" })).toBeInTheDocument();
        expect(screen.getByText(/Your password has been successfully updated/i)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Continue to Sign In" })).toBeInTheDocument();

        const postCall = calls.find((c) => c.method === "POST" && c.path === "/auth/reset-password");
        expect(postCall).toBeDefined();
        expect(postCall?.body).toEqual({
            token: "valid-token-xyz",
            password: "NewAwesomePassword123!",
        });
    });
});
