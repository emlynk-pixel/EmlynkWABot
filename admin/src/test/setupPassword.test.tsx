import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { SESSION_TOKEN, fakeAuth, renderApp, stubBackend } from "./helpers";

const INVITEE = { userId: "u-9", email: "invitee@example.invalid", name: "Invitee", role: "MANAGER", status: "ACTIVE" };

// The Supabase invite link signs the invitee in: a session is present when
// the page loads (detectSessionInUrl).
// GET /auth/me answers 403 (INVITED) until POST /auth/complete-invite succeeds.
function arriveFromInvite(routes = {}) {
    fakeAuth.setSession(SESSION_TOKEN, INVITEE.email);
    let activated = false;
    return stubBackend({
        "GET /auth/me": () => (activated
            ? { status: 200, body: { user: INVITEE } }
            : { status: 403, body: { message: "Your account is not active. Contact an administrator.", code: "ACCOUNT_NOT_ACTIVE" } }),
        "POST /auth/complete-invite": () => {
            activated = true;
            return { status: 200, body: { user: INVITEE } };
        },
        ...routes,
    });
}

async function submit(password = "Strong-Password-9", confirm = password) {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New Password"), password);
    await user.type(screen.getByLabelText("Confirm Password"), confirm);
    await user.click(screen.getByRole("button", { name: "Activate Account" }));
}

describe("Setup Password page (Supabase invitation)", () => {
    test("shows the invitee's email from the Supabase session; the INVITED account is not signed in to the app yet", async () => {
        arriveFromInvite();
        renderApp("/setup-password");
        expect(await screen.findByRole("heading", { name: "Set Your Password" })).toBeInTheDocument();
        expect(screen.getByLabelText("Email Address")).toHaveValue(INVITEE.email);
        expect(fakeAuth.currentSession, "the invite session is kept for setup").not.toBeNull();
    });

    test("sets the password with Supabase, then activates the account, then enters the console", async () => {
        const { calls } = arriveFromInvite();
        renderApp("/setup-password");
        await screen.findByRole("heading", { name: "Set Your Password" });
        await submit();

        expect(await screen.findByText("Account Activated!")).toBeInTheDocument();
        expect(fakeAuth.calls.find((c) => c.method === "updateUser")?.args).toEqual([{ password: "Strong-Password-9" }]);
        const complete = calls.find((c) => c.path === "/auth/complete-invite");
        expect(complete?.method).toBe("POST");
        expect(complete?.headers.Authorization).toBe(`Bearer ${SESSION_TOKEN}`);
        expect(complete?.body, "the role is never sent by the invitee").toBeUndefined();
        expect(JSON.stringify(calls)).not.toContain("Strong-Password-9");

        await userEvent.setup().click(screen.getByRole("button", { name: "Continue to the console" }));
        expect(await screen.findByTestId("admin-name")).toHaveTextContent("Invitee");
    });

    test("an expired or used invite link -> invitation problem, no form", async () => {
        window.location.hash = "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";
        stubBackend({});
        renderApp("/setup-password");
        expect(await screen.findByText("Invitation Problem")).toBeInTheDocument();
        expect(screen.getByText(/invalid or has expired/)).toBeInTheDocument();
        expect(screen.queryByLabelText("New Password")).not.toBeInTheDocument();
    });

    test("no Supabase session (link opened without its tokens) -> invitation problem", async () => {
        stubBackend({});
        renderApp("/setup-password");
        expect(await screen.findByText("Invitation Problem")).toBeInTheDocument();
    });

    test("a revoked invitation is refused after the password step", async () => {
        arriveFromInvite({ "POST /auth/complete-invite": { status: 403, body: { message: "x", code: "ACCOUNT_NOT_ACTIVE" } } });
        renderApp("/setup-password");
        await screen.findByRole("heading", { name: "Set Your Password" });
        await submit();
        expect(await screen.findByRole("alert")).toHaveTextContent("This invitation is no longer valid");
    });

    test("mismatched passwords are caught before Supabase is called", async () => {
        arriveFromInvite();
        renderApp("/setup-password");
        await screen.findByRole("heading", { name: "Set Your Password" });
        await submit("Strong-Password-9", "Different-Password-9");
        expect(screen.getByLabelText("Confirm Password")).toHaveAttribute("aria-invalid", "true");
        expect(fakeAuth.calls.some((c) => c.method === "updateUser")).toBe(false);
    });

    test("a password Supabase rejects as weak -> a clear message, account not activated", async () => {
        fakeAuth.failures.update = { status: 422, code: "weak_password" };
        const { calls } = arriveFromInvite();
        renderApp("/setup-password");
        await screen.findByRole("heading", { name: "Set Your Password" });
        await submit();
        expect(await screen.findByRole("alert")).toHaveTextContent("Choose a stronger password.");
        expect(calls.some((c) => c.path === "/auth/complete-invite")).toBe(false);
    });
});
