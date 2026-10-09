import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { ADMIN, OVERVIEW, SESSION_TOKEN, fakeAuth, newToken, renderApp, signedInBackend, stubBackend, userWithRole } from "./helpers";

const PASSWORD = "Correct-Horse-7";

async function fillAndSubmit(email = ADMIN.email, password = PASSWORD) {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), email);
    await user.type(screen.getByLabelText("Password"), password);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    return user;
}

const backendFor = (profile: object, extra = {}) => stubBackend({
    "GET /auth/me": { status: 200, body: { user: profile } },
    "GET /api/admin/overview": { status: 200, body: OVERVIEW },
    ...extra,
});

describe("route guard", () => {
    test("an unauthenticated visitor is redirected to the login page, nothing requested", async () => {
        const { calls } = stubBackend({});
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
        expect(calls).toHaveLength(0);
    });

    test("every dashboard section is protected", async () => {
        stubBackend({});
        for (const path of ["/documents", "/review", "/clients", "/police", "/invitations", "/anything"]) {
            const { unmount } = renderApp(path);
            expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
            unmount();
        }
    });
});

describe("login (Supabase Auth)", () => {
    test("valid credentials -> Supabase sign-in, then GET /auth/me with the Supabase access token", async () => {
        const token = newToken();
        fakeAuth.addAccount(ADMIN.email, PASSWORD, token);
        const { calls } = backendFor(ADMIN);
        renderApp("/");
        await screen.findByRole("heading", { name: "Sign in" });
        await fillAndSubmit();

        expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
        expect(screen.getByTestId("admin-name")).toHaveTextContent("Test Admin");
        expect(fakeAuth.calls.find((c) => c.method === "signInWithPassword")?.args).toEqual([{ email: ADMIN.email, password: PASSWORD }]);
        expect(calls[0].path).toBe("/auth/me");
        expect(calls[0].headers.Authorization).toBe(`Bearer ${token}`);
        expect(calls.every((c) => !c.path.startsWith("/auth/login")), "no backend login endpoint").toBe(true);
        expect(JSON.stringify(calls)).not.toContain(PASSWORD);
        expect(window.sessionStorage.getItem("emlynk.admin.token")).toBeNull();
    });

    test("after login the user returns to the page they asked for", async () => {
        fakeAuth.addAccount(ADMIN.email, PASSWORD, newToken());
        backendFor(ADMIN);
        renderApp("/review");
        await screen.findByRole("heading", { name: "Sign in" });
        await fillAndSubmit();
        expect(await screen.findByRole("heading", { name: "Review Queue" })).toBeInTheDocument();
    });

    test("wrong credentials -> one generic message, no session, the backend never called", async () => {
        fakeAuth.addAccount(ADMIN.email, PASSWORD, newToken());
        const { calls } = stubBackend({});
        renderApp("/login");
        await fillAndSubmit(ADMIN.email, "wrong-password");

        expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
        expect(screen.getByLabelText("Password")).toHaveValue("");
        expect(fakeAuth.currentSession).toBeNull();
        expect(calls).toHaveLength(0);
    });

    test("an unknown email gets the same message as a wrong password", async () => {
        stubBackend({});
        renderApp("/login");
        await fillAndSubmit("nobody@example.invalid", "whatever-password");
        expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    });

    test("valid credentials but no ACTIVE application user -> refused, Supabase session ended", async () => {
        fakeAuth.addAccount(ADMIN.email, PASSWORD, newToken());
        stubBackend({ "GET /auth/me": { status: 403, body: { message: "Your account is not active. Contact an administrator.", code: "ACCOUNT_NOT_ACTIVE" } } });
        renderApp("/login");
        await fillAndSubmit();
        expect(await screen.findByRole("alert")).toHaveTextContent("Your account is not active. Contact an administrator.");
        expect(fakeAuth.currentSession).toBeNull();
        expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
    });

    test("Supabase rate limiting -> its message is shown", async () => {
        fakeAuth.failures.signIn = { status: 429, code: "over_request_rate_limit" };
        stubBackend({});
        renderApp("/login");
        await fillAndSubmit();
        expect(await screen.findByRole("alert")).toHaveTextContent("Too many sign-in attempts");
    });

    test("other failures never show provider or backend details", async () => {
        fakeAuth.failures.signIn = { status: 500, message: "upstream gotrue failure at /srv/auth" };
        stubBackend({});
        renderApp("/login");
        await fillAndSubmit();
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Something went wrong. Please try again.");
        expect(alert).not.toHaveTextContent("/srv");
    });

    test("empty fields are caught before any request", async () => {
        const { calls } = stubBackend({});
        renderApp("/login");
        await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in" }));
        expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("Enter your email address.");
        expect(screen.getByLabelText("Password")).toHaveAccessibleDescription("Enter your password.");
        expect(calls).toHaveLength(0);
        expect(fakeAuth.calls.some((c) => c.method === "signInWithPassword")).toBe(false);
    });

    test("an already signed-in user opening /login goes to the dashboard", async () => {
        signedInBackend();
        renderApp("/login");
        expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    });
});

describe("session restore (page refresh)", () => {
    test("a stored Supabase session is checked with GET /auth/me and restores the app", async () => {
        fakeAuth.setSession(SESSION_TOKEN);
        const { calls } = backendFor(ADMIN);
        renderApp("/clients");
        expect(await screen.findByRole("heading", { name: "Clients" })).toBeInTheDocument();
        expect(calls[0].headers.Authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    });

    test("a session the backend rejects (401) is ended -> login", async () => {
        fakeAuth.setSession(SESSION_TOKEN);
        stubBackend({ "GET /auth/me": { status: 401, body: { message: "Invalid or Expired Token" } } });
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(fakeAuth.currentSession).toBeNull();
    });

    test("a deactivated or missing application user (403) -> login with the reason", async () => {
        fakeAuth.setSession(SESSION_TOKEN);
        stubBackend({ "GET /auth/me": { status: 403, body: { message: "x", code: "ACCOUNT_NOT_ACTIVE" } } });
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("Your account is not active");
    });

    test("no session (expired and not refreshable) -> login, the backend never called", async () => {
        const { calls } = stubBackend({});
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(calls).toHaveLength(0);
    });

    test("backend unreachable -> not signed in, not stuck on the loading screen", async () => {
        fakeAuth.setSession(SESSION_TOKEN);
        stubBackend({});
        (globalThis.fetch as unknown as { mockRejectedValue: (e: Error) => void }).mockRejectedValue(new TypeError("Failed to fetch"));
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    });

    test("a refreshed Supabase access token is used for the next API call", async () => {
        const { calls } = signedInBackend({ "GET /api/admin/documents": { status: 200, body: { items: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 }, summary: { total: 0, byVerificationStatus: {} } } } });
        renderApp("/");
        await screen.findByText("Total clients");
        const refreshed = newToken();
        act(() => fakeAuth.refreshToken(refreshed));
        await userEvent.setup().click(within(screen.getByRole("navigation", { name: "Main navigation" })).getByRole("link", { name: "Documents" }));
        await screen.findByRole("heading", { name: "Documents" });
        expect(calls.find((c) => c.path.startsWith("/api/admin/documents"))?.headers.Authorization).toBe(`Bearer ${refreshed}`);
    });

    test("Supabase ending the session (refresh failed) signs the app out", async () => {
        signedInBackend();
        renderApp("/");
        await screen.findByTestId("admin-name");
        act(() => fakeAuth.expireSession());
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    });
});

describe("dashboard shell", () => {
    async function signedIn(path = "/", profile: object = ADMIN) {
        fakeAuth.setSession(SESSION_TOKEN);
        backendFor(profile);
        renderApp(path);
        await screen.findByTestId("admin-name");
    }
    const navLinks = () => within(screen.getByRole("navigation", { name: "Main navigation" })).getAllByRole("link").map((link) => link.textContent);

    test("ADMIN: every section, then Invite User, Change Roles and Settings", async () => {
        await signedIn();
        expect(navLinks()).toEqual(["Overview", "Documents", "Review Queue", "Candidates", "Missing Documents", "Police Workflow", "Daily Report", "Invite User", "Change Roles", "Settings"]);
        await userEvent.setup().click(screen.getByRole("link", { name: "Police Workflow" }));
        expect(await screen.findByRole("heading", { name: "Police Workflow" })).toBeInTheDocument();
    });

    test("MANAGER and ANALYST: the dashboard sections, no user management or Settings", async () => {
        for (const role of ["MANAGER", "ANALYST"]) {
            await signedIn("/", userWithRole(role));
            expect(navLinks()).toEqual(["Overview", "Documents", "Review Queue", "Candidates", "Missing Documents", "Police Workflow", "Daily Report"]);
            document.body.innerHTML = "";
        }
    });

    test("REGISTRATION_DESK: Candidates only, and lands there instead of the Overview", async () => {
        await signedIn("/", userWithRole("REGISTRATION_DESK"));
        expect(navLinks()).toEqual(["Candidates"]);
        expect(await screen.findByRole("heading", { name: "Candidates", level: 1 })).toBeInTheDocument();
    });

    test("the header shows the role's label", async () => {
        await signedIn("/", userWithRole("REGISTRATION_DESK"));
        expect(screen.getByText("Registration Desk")).toBeInTheDocument();
    });

    test("the session is checked before any dashboard data is requested", async () => {
        await signedIn();
        await screen.findByText("Total clients");
        const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
        expect(calls[0]).toBe("/auth/me");
        expect(calls).toContain("/api/admin/overview");
        expect(calls).toContain("/api/admin/review?page=1&pageSize=100&order=desc");
    });

    test("the sidebar collapses to an icon rail and remembers it", async () => {
        await signedIn();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Collapse" }));
        expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
        expect(window.localStorage.getItem("emlynk.admin.sidebarCollapsed")).toBe("1");
    });

    test("sign out ends the Supabase session everywhere and returns to the login page", async () => {
        await signedIn("/documents");
        await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));

        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(fakeAuth.calls.find((c) => c.method === "signOut")?.args).toEqual([undefined]);
        expect(fakeAuth.currentSession).toBeNull();
    });

    test("sign out still clears the local session when Supabase can't be reached", async () => {
        await signedIn();
        fakeAuth.failures.signOut = { status: 0, message: "network" };
        await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(fakeAuth.calls.filter((c) => c.method === "signOut").map((c) => c.args[0])).toEqual([undefined, { scope: "local" }]);
    });

    test("unknown paths inside the app show a not-found page", async () => {
        await signedIn("/no-such-page");
        expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    });
});
