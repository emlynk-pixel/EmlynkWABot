import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { ADMIN, OVERVIEW, TOKEN_KEY, fakeJwt, renderApp, signedInBackend, stubBackend } from "./helpers";

async function fillAndSubmit(email = ADMIN.email, password = "Correct-Horse-7") {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), email);
    await user.type(screen.getByLabelText("Password"), password);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    return user;
}

describe("route guard", () => {
    test("an unauthenticated visitor is redirected to the login page", async () => {
        const { calls } = stubBackend({});
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
        expect(calls).toHaveLength(0);
    });

    test("every dashboard section is protected", async () => {
        stubBackend({});
        for (const path of ["/documents", "/review", "/clients", "/police", "/anything"]) {
            const { unmount } = renderApp(path);
            expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
            unmount();
        }
    });
});

describe("login", () => {
    test("valid credentials -> POST /auth/login, GET /auth/me, dashboard shell", async () => {
        const token = fakeJwt();
        const { calls } = stubBackend({
            "POST /auth/login": { status: 200, body: { message: "Login successful", token } },
            "GET /auth/me": { status: 200, body: { message: "ok", admin: ADMIN } },
            "GET /api/admin/overview": { status: 200, body: OVERVIEW },
        });
        renderApp("/");
        await screen.findByRole("heading", { name: "Sign in" });
        await fillAndSubmit();

        expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
        expect(screen.getByTestId("admin-name")).toHaveTextContent("Test Admin");
        expect(calls.slice(0, 2).map((c) => `${c.method} ${c.path}`)).toEqual(["POST /auth/login", "GET /auth/me"]);
        expect(calls[0].body).toEqual({ email: ADMIN.email, password: "Correct-Horse-7" });
        expect(calls[1].headers.Authorization).toBe(`Bearer ${token}`);
        expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe(token);
    });

    test("after login the admin returns to the page they asked for", async () => {
        stubBackend({
            "POST /auth/login": { status: 200, body: { token: fakeJwt() } },
            "GET /auth/me": { status: 200, body: { admin: ADMIN } },
        });
        renderApp("/review");
        await screen.findByRole("heading", { name: "Sign in" });
        await fillAndSubmit();
        expect(await screen.findByRole("heading", { name: "Review Queue" })).toBeInTheDocument();
    });

    test("wrong credentials -> the backend's generic message, no token stored", async () => {
        stubBackend({ "POST /auth/login": { status: 401, body: { message: "Invalid email or password" } } });
        renderApp("/login");
        await fillAndSubmit(ADMIN.email, "wrong-password");

        expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
        expect(screen.getByLabelText("Password")).toHaveValue("");
        expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    });

    test("rate limited -> the backend's message is shown", async () => {
        stubBackend({ "POST /auth/login": { status: 429, body: { message: "Too many login attempts. Please try again later." } } });
        renderApp("/login");
        await fillAndSubmit();
        expect(await screen.findByRole("alert")).toHaveTextContent("Too many login attempts");
    });

    test("server errors never show backend details", async () => {
        stubBackend({ "POST /auth/login": { status: 500, body: { message: "Internal server error at /srv/app.js" } } });
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
        expect(await screen.findByRole("alert")).toHaveTextContent("Enter your email and password.");
        expect(calls).toHaveLength(0);
    });

    test("an already signed-in admin opening /login goes to the dashboard", async () => {
        window.sessionStorage.setItem(TOKEN_KEY, fakeJwt());
        stubBackend({ "GET /auth/me": { status: 200, body: { admin: ADMIN } } });
        renderApp("/login");
        expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    });
});

describe("session restore", () => {
    test("a stored valid token is checked with GET /auth/me and restores the session", async () => {
        const token = fakeJwt();
        window.sessionStorage.setItem(TOKEN_KEY, token);
        const { calls } = stubBackend({ "GET /auth/me": { status: 200, body: { admin: ADMIN } } });
        renderApp("/clients");

        expect(await screen.findByRole("heading", { name: "Clients" })).toBeInTheDocument();
        expect(calls[0].headers.Authorization).toBe(`Bearer ${token}`);
    });

    test("a stored token the backend rejects (e.g. admin deactivated) is cleared -> login", async () => {
        window.sessionStorage.setItem(TOKEN_KEY, fakeJwt());
        stubBackend({ "GET /auth/me": { status: 401, body: { message: "Invalid or Expired Token" } } });
        renderApp("/");

        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    });

    test("an expired stored token is dropped without calling the backend", async () => {
        window.sessionStorage.setItem(TOKEN_KEY, fakeJwt(-60));
        const { calls } = stubBackend({});
        renderApp("/");

        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(calls).toHaveLength(0);
        expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    });

    test("backend unreachable -> signed out, not stuck on the loading screen", async () => {
        window.sessionStorage.setItem(TOKEN_KEY, fakeJwt());
        stubBackend({});
        (globalThis.fetch as unknown as { mockRejectedValue: (e: Error) => void }).mockRejectedValue(new TypeError("Failed to fetch"));
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    });
});

describe("dashboard shell", () => {
    async function signedIn(path = "/") {
        signedInBackend();
        renderApp(path);
        await screen.findByTestId("admin-name");
    }

    test("sidebar lists the Stitch sections and navigates between them", async () => {
        await signedIn();
        const nav = screen.getByRole("navigation", { name: "Main navigation" });
        const links = within(nav).getAllByRole("link").map((link) => link.textContent);
        expect(links).toEqual(["Overview", "Documents", "Review Queue", "Clients", "Police Workflow"]);

        await userEvent.setup().click(within(nav).getByRole("link", { name: "Police Workflow" }));
        expect(await screen.findByRole("heading", { name: "Police Workflow" })).toBeInTheDocument();
        expect(within(nav).getByRole("link", { name: "Police Workflow" })).toHaveAttribute("aria-current", "page");
    });

    test("the session is checked before any dashboard data is requested", async () => {
        await signedIn();
        await screen.findByText("Total clients");
        const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
        expect(calls).toEqual(["/auth/me", "/api/admin/overview"]);
    });

    test("the sidebar collapses to an icon rail and remembers it", async () => {
        await signedIn();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Collapse" }));
        expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
        expect(window.localStorage.getItem("emlynk.admin.sidebarCollapsed")).toBe("1");
    });

    test("sign out clears the token and returns to the login page", async () => {
        await signedIn("/documents");
        await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));

        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    });

    test("unknown paths inside the app show a not-found page", async () => {
        await signedIn("/no-such-page");
        expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    });
});
