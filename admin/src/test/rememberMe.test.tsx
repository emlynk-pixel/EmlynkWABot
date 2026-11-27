// "Remember me" on the login page (auth/supabaseClient.ts, AuthProvider.tsx):
// ticked, the shared localStorage session survives a browser restart (30 days
// at most, enforced by the backend); unticked, it ends when the browser closes,
// detected by a browser-session marker cookie. Synthetic accounts and tokens only.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { ADMIN, OVERVIEW, SESSION_TOKEN, fakeAuth, newToken, renderApp, renderAppSignedIn, signedInBackend, stubBackend } from "./helpers";

const actual = await vi.importActual<typeof import("../auth/supabaseClient")>("../auth/supabaseClient");
const { AUTH_STORAGE_KEY: KEY, REMEMBER_KEY, ALIVE_COOKIE } = actual;
const STORED = JSON.stringify({ access_token: "fake-access-token", refresh_token: "fake-refresh-token" });
const PASSWORD = "Correct-Horse-7";

const markerSet = () => document.cookie.split(";").some((part) => part.trim() === `${ALIVE_COOKIE}=1`);
const setMarker = () => { document.cookie = `${ALIVE_COOKIE}=1; path=/`; };
const fakeSignOut = () => vi.fn(async (_options?: { scope?: string }) => ({ error: null }));

describe("login page: Remember me checkbox", () => {
    test("is a real checkbox below the password, above Sign in, unticked by default", async () => {
        stubBackend({});
        renderApp("/login");
        const box = await screen.findByRole("checkbox", { name: "Remember me" });
        expect(box).toHaveAttribute("id", "remember-me");
        expect(box).not.toBeChecked();
        const password = screen.getByLabelText("Password");
        const submit = screen.getByRole("button", { name: "Sign in" });
        expect(password.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(box.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test("clicking the label toggles it", async () => {
        stubBackend({});
        const user = userEvent.setup();
        renderApp("/login");
        const box = await screen.findByRole("checkbox", { name: "Remember me" });
        await user.click(screen.getByText("Remember me"));
        expect(box).toBeChecked();
        await user.click(screen.getByText("Remember me"));
        expect(box).not.toBeChecked();
    });

    test("Space toggles it from the keyboard", async () => {
        stubBackend({});
        const user = userEvent.setup();
        renderApp("/login");
        const box = await screen.findByRole("checkbox", { name: "Remember me" });
        box.focus();
        await user.keyboard(" ");
        expect(box).toBeChecked();
        await user.keyboard(" ");
        expect(box).not.toBeChecked();
    });
});

describe("sign-in passes the choice on", () => {
    async function signInWith(remember: boolean) {
        fakeAuth.addAccount(ADMIN.email, PASSWORD, newToken());
        stubBackend({ "GET /auth/me": { status: 200, body: { user: ADMIN } }, "GET /api/admin/overview": { status: 200, body: OVERVIEW } });
        const user = userEvent.setup();
        renderApp("/login");
        await user.type(await screen.findByLabelText("Email"), ADMIN.email);
        await user.type(screen.getByLabelText("Password"), PASSWORD);
        if (remember) await user.click(screen.getByRole("checkbox", { name: "Remember me" }));
        await user.click(screen.getByRole("button", { name: "Sign in" }));
        expect(await screen.findByTestId("admin-name")).toBeInTheDocument();
    }

    const expectNoPasswordStored = () => {
        for (const store of [window.localStorage, window.sessionStorage]) {
            for (let i = 0; i < store.length; i++) {
                const key = store.key(i)!;
                expect(`${key}=${store.getItem(key)}`).not.toContain(PASSWORD);
            }
        }
        expect(document.cookie).not.toContain(PASSWORD);
        expect(document.cookie).not.toMatch(/token/i);
    };

    test("ticked: the remember flag is \"1\"; the password is stored nowhere", async () => {
        await signInWith(true);
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBe("1");
        expect(fakeAuth.calls.find((c) => c.method === "signInWithPassword")?.args).toEqual([{ email: ADMIN.email, password: PASSWORD }]);
        expectNoPasswordStored();
    });

    test("ticked but the sign-in fails: no \"1\" is left behind (a stale \"1\" is cleared too)", async () => {
        window.localStorage.setItem(REMEMBER_KEY, "1");
        fakeAuth.addAccount(ADMIN.email, PASSWORD, newToken());
        stubBackend({});
        const user = userEvent.setup();
        renderApp("/login");
        await user.type(await screen.findByLabelText("Email"), ADMIN.email);
        await user.type(screen.getByLabelText("Password"), "wrong-password");
        await user.click(screen.getByRole("checkbox", { name: "Remember me" }));
        await user.click(screen.getByRole("button", { name: "Sign in" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBeNull();
    });

    test("ticked, valid credentials but no active account: no \"1\" is left behind", async () => {
        fakeAuth.addAccount(ADMIN.email, PASSWORD, newToken());
        stubBackend({ "GET /auth/me": { status: 403, body: { message: "Forbidden" } } });
        const user = userEvent.setup();
        renderApp("/login");
        await user.type(await screen.findByLabelText("Email"), ADMIN.email);
        await user.type(screen.getByLabelText("Password"), PASSWORD);
        await user.click(screen.getByRole("checkbox", { name: "Remember me" }));
        await user.click(screen.getByRole("button", { name: "Sign in" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Your account is not active");
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBeNull();
    });

    test("unticked: the remember flag is \"0\"; the password is stored nowhere", async () => {
        await signInWith(false);
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBe("0");
        expectNoPasswordStored();
    });
});

describe("setRememberChoice and clearing the flag", () => {
    test("writes \"1\" or \"0\"", () => {
        actual.setRememberChoice(true);
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBe("1");
        actual.setRememberChoice(false);
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBe("0");
    });

    test("removing the stored session clears the flag; other keys leave it", () => {
        actual.setRememberChoice(true);
        actual.sessionStore.removeItem(`${KEY}-user`);
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBe("1");
        actual.sessionStore.removeItem(KEY);
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBeNull();
    });

    test("sign out removes the remember flag", async () => {
        signedInBackend();
        await renderAppSignedIn("/");
        window.localStorage.setItem(REMEMBER_KEY, "1");
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /^Account:/ }));
        await user.click(screen.getByRole("button", { name: "Sign out" }));
        expect(await screen.findByRole("heading", { name: "Sign in to EMOPS" })).toBeInTheDocument();
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBeNull();
    });
});

describe("endSessionIfBrowserWasClosed", () => {
    test("(a) not remembered, no marker, a stored session: signed out locally and the session cleared", async () => {
        window.localStorage.setItem(KEY, STORED);
        window.localStorage.setItem(REMEMBER_KEY, "0");
        const signOut = fakeSignOut();
        await actual.endSessionIfBrowserWasClosed({ signOut } as never);
        expect(signOut).toHaveBeenCalledTimes(1);
        expect(signOut).toHaveBeenCalledWith({ scope: "local" });
        expect(window.localStorage.getItem(KEY)).toBeNull();
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBeNull();
        expect(markerSet()).toBe(true);
    });

    test("(a) with no flag at all (a session from before this change) it is ended too", async () => {
        window.localStorage.setItem(KEY, STORED);
        const signOut = fakeSignOut();
        await actual.endSessionIfBrowserWasClosed({ signOut } as never);
        expect(signOut).toHaveBeenCalledWith({ scope: "local" });
        expect(window.localStorage.getItem(KEY)).toBeNull();
    });

    test("(a) the session is cleared even when the sign-out fails", async () => {
        window.localStorage.setItem(KEY, STORED);
        const signOut = vi.fn(async () => { throw new Error("network"); });
        await actual.endSessionIfBrowserWasClosed({ signOut } as never);
        expect(window.localStorage.getItem(KEY)).toBeNull();
        expect(markerSet()).toBe(true);
    });

    test("(b) not remembered, marker present (browser still open, e.g. a new tab): kept", async () => {
        window.localStorage.setItem(KEY, STORED);
        window.localStorage.setItem(REMEMBER_KEY, "0");
        setMarker();
        const signOut = fakeSignOut();
        await actual.endSessionIfBrowserWasClosed({ signOut } as never);
        expect(signOut).not.toHaveBeenCalled();
        expect(window.localStorage.getItem(KEY)).toBe(STORED);
        expect(markerSet()).toBe(true);
    });

    test("(c) remembered, no marker (browser restarted): kept", async () => {
        window.localStorage.setItem(KEY, STORED);
        window.localStorage.setItem(REMEMBER_KEY, "1");
        const signOut = fakeSignOut();
        await actual.endSessionIfBrowserWasClosed({ signOut } as never);
        expect(signOut).not.toHaveBeenCalled();
        expect(window.localStorage.getItem(KEY)).toBe(STORED);
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBe("1");
        expect(markerSet()).toBe(true);
    });

    test("(d) no stored session: nothing to do", async () => {
        const signOut = fakeSignOut();
        await actual.endSessionIfBrowserWasClosed({ signOut } as never);
        expect(signOut).not.toHaveBeenCalled();
        expect(markerSet()).toBe(true);
    });

    test("an invite / recovery link being opened: the old copy is dropped without a sign-out that would end the new session", async () => {
        window.localStorage.setItem(KEY, STORED);
        window.location.hash = "#access_token=fake-link-token&type=invite";
        const signOut = fakeSignOut();
        await actual.endSessionIfBrowserWasClosed({ signOut } as never);
        expect(signOut).not.toHaveBeenCalled();
        expect(window.localStorage.getItem(KEY)).toBeNull();
        expect(markerSet()).toBe(true);
    });

    test("a session from a link clears an earlier \"remember\" choice, whatever is stored or marked", async () => {
        window.location.hash = "#access_token=fake-link-token&type=recovery";
        const signOut = fakeSignOut();

        window.localStorage.setItem(REMEMBER_KEY, "1");
        await actual.endSessionIfBrowserWasClosed({ signOut } as never);
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBeNull();

        window.localStorage.setItem(KEY, STORED);
        window.localStorage.setItem(REMEMBER_KEY, "1");
        setMarker();
        await actual.endSessionIfBrowserWasClosed({ signOut } as never);
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBeNull();
        expect(signOut).not.toHaveBeenCalled();
    });

    test("without a link session a remembered choice is left alone", async () => {
        window.location.hash = "#error=access_denied&error_code=otp_expired";
        window.localStorage.setItem(REMEMBER_KEY, "1");
        await actual.endSessionIfBrowserWasClosed({ signOut: fakeSignOut() } as never);
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBe("1");
    });
});

describe("app start-up", () => {
    test("a not-remembered session after the browser was closed: signed out, login page", async () => {
        signedInBackend();
        window.localStorage.setItem(KEY, STORED);
        window.localStorage.setItem(REMEMBER_KEY, "0");
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Sign in to EMOPS" })).toBeInTheDocument();
        expect(fakeAuth.calls.find((c) => c.method === "signOut")?.args).toEqual([{ scope: "local" }]);
        expect(fakeAuth.currentSession).toBeNull();
        expect(window.localStorage.getItem(KEY)).toBeNull();
    });

    test("a not-remembered session in the same browser session (new tab, reload): still signed in", async () => {
        signedInBackend();
        window.localStorage.setItem(KEY, STORED);
        window.localStorage.setItem(REMEMBER_KEY, "0");
        setMarker();
        await renderAppSignedIn("/");
        expect(fakeAuth.calls.some((c) => c.method === "signOut")).toBe(false);
        expect(fakeAuth.currentSession?.access_token).toBe(SESSION_TOKEN);
    });

    test("a remembered session after a browser restart: still signed in", async () => {
        signedInBackend();
        window.localStorage.setItem(KEY, STORED);
        window.localStorage.setItem(REMEMBER_KEY, "1");
        await renderAppSignedIn("/");
        expect(fakeAuth.calls.some((c) => c.method === "signOut")).toBe(false);
        await waitFor(() => expect(markerSet()).toBe(true));
    });

    test("a remembered session the backend rejects (over 30 days: 401) is signed out locally", async () => {
        fakeAuth.setSession(SESSION_TOKEN, ADMIN.email);
        stubBackend({ "GET /auth/me": { status: 401, body: { message: "Invalid or Expired Token" } } });
        window.localStorage.setItem(KEY, STORED);
        window.localStorage.setItem(REMEMBER_KEY, "1");
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Sign in to EMOPS" })).toBeInTheDocument();
        expect(fakeAuth.calls.find((c) => c.method === "signOut")?.args).toEqual([{ scope: "local" }]);
        expect(fakeAuth.currentSession).toBeNull();
    });

    test("a 401 from a page's API call mid-session signs the user out", async () => {
        fakeAuth.setSession(SESSION_TOKEN, ADMIN.email);
        window.localStorage.setItem(REMEMBER_KEY, "1");
        const { calls } = stubBackend({
            "GET /auth/me": { status: 200, body: { user: ADMIN } },
            "GET /api/admin/overview": { status: 401, body: { message: "Invalid or Expired Token" } },
        });
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Sign in to EMOPS" })).toBeInTheDocument();
        expect(calls.some((c) => c.path.startsWith("/api/admin/overview"))).toBe(true);
        expect(fakeAuth.currentSession).toBeNull();
        expect(window.localStorage.getItem(REMEMBER_KEY)).toBeNull();
    });
});
