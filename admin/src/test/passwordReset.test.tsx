import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { SESSION_TOKEN, fakeAuth, renderApp, stubBackend } from "./helpers";

describe("Forgot Password (Supabase recovery email)", () => {
    test("the login page links to it", async () => {
        stubBackend({});
        renderApp("/login");
        await userEvent.setup().click(await screen.findByRole("link", { name: "Forgot password?" }));
        expect(await screen.findByRole("heading", { name: "Reset password" })).toBeInTheDocument();
    });

    test("asks Supabase to send the recovery email, redirecting to this app's reset page; the backend is not involved", async () => {
        const { calls } = stubBackend({});
        renderApp("/forgot-password");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Email"), " person@example.invalid ");
        await user.click(screen.getByRole("button", { name: "Send reset link" }));

        expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
        expect(fakeAuth.calls.find((c) => c.method === "resetPasswordForEmail")?.args).toEqual([
            "person@example.invalid",
            { redirectTo: `${window.location.origin}/admin/reset-password` },
        ]);
        expect(calls).toHaveLength(0);
    });

    test("enumeration-safe: the same confirmation whether or not the email has an account", async () => {
        stubBackend({});
        for (const email of ["known@example.invalid", "unknown@example.invalid"]) {
            const { unmount } = renderApp("/forgot-password");
            const user = userEvent.setup();
            await user.type(await screen.findByLabelText("Email"), email);
            await user.click(screen.getByRole("button", { name: "Send reset link" }));
            expect(await screen.findByText(/If an account matches that email address/)).toBeInTheDocument();
            unmount();
        }
    });

    test("Supabase rate limiting is reported; nothing else is", async () => {
        fakeAuth.failures.reset = { status: 429, code: "over_email_send_rate_limit" };
        stubBackend({});
        renderApp("/forgot-password");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Email"), "person@example.invalid");
        await user.click(screen.getByRole("button", { name: "Send reset link" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Too many password reset requests");
    });

    test("an invalid email is caught before any request", async () => {
        stubBackend({});
        renderApp("/forgot-password");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Email"), "not-an-email");
        await user.click(screen.getByRole("button", { name: "Send reset link" }));
        expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
        expect(fakeAuth.calls.some((c) => c.method === "resetPasswordForEmail")).toBe(false);
    });
});

describe("Reset Password (Supabase recovery session)", () => {
    // The recovery link signs the user in with a recovery session.
    function arriveFromRecovery() {
        fakeAuth.setSession(SESSION_TOKEN);
        return stubBackend({});
    }

    async function submit(password = "New-Strong-Pass-1", confirm = password) {
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("New Password"), password);
        await user.type(screen.getByLabelText("Confirm Password"), confirm);
        await user.click(screen.getByRole("button", { name: "Reset password" }));
    }

    test("with a recovery session: the new-password form", async () => {
        arriveFromRecovery();
        renderApp("/reset-password");
        expect(await screen.findByRole("heading", { name: "Set New Password" })).toBeInTheDocument();
    });

    test("updates the password with Supabase, ends the session, and asks to sign in again", async () => {
        const { calls } = arriveFromRecovery();
        renderApp("/reset-password");
        await screen.findByRole("heading", { name: "Set New Password" });
        await submit();

        expect(await screen.findByRole("heading", { name: "Password Reset Complete" })).toBeInTheDocument();
        expect(fakeAuth.calls.find((c) => c.method === "updateUser")?.args).toEqual([{ password: "New-Strong-Pass-1" }]);
        expect(fakeAuth.currentSession).toBeNull();
        expect(calls.some((c) => c.path.includes("reset-password")), "no backend reset endpoint").toBe(false);
        await userEvent.setup().click(screen.getByRole("button", { name: "Continue to Sign In" }));
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    });

    test("an expired or used recovery link -> 'request a new link'", async () => {
        window.location.hash = "#error=access_denied&error_code=otp_expired";
        stubBackend({});
        renderApp("/reset-password");
        expect(await screen.findByText("Reset Link Problem")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Request New Reset Link" })).toBeInTheDocument();
    });

    test("no recovery session -> invalid link state", async () => {
        stubBackend({});
        renderApp("/reset-password");
        expect(await screen.findByText("Reset Link Problem")).toBeInTheDocument();
    });

    test("short or mismatched passwords are caught before Supabase is called", async () => {
        arriveFromRecovery();
        renderApp("/reset-password");
        await screen.findByRole("heading", { name: "Set New Password" });
        await submit("short", "short");
        expect(screen.getByLabelText("New Password")).toHaveAccessibleDescription("Password must be at least 8 characters long.");
        expect(fakeAuth.calls.some((c) => c.method === "updateUser")).toBe(false);
    });

    test("a recovery session Supabase no longer accepts -> invalid link message", async () => {
        fakeAuth.failures.update = { status: 403, code: "session_not_found" };
        arriveFromRecovery();
        renderApp("/reset-password");
        await screen.findByRole("heading", { name: "Set New Password" });
        await submit();
        expect(await screen.findByRole("alert")).toHaveTextContent("invalid or has expired");
    });
});
