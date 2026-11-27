// The login session is shared by every tab (localStorage, auth/supabaseClient.ts)
// and the header's Back button steps one entry back in the app's history.
// Synthetic tokens only; the backend is stubbed.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { RENDER_STEP, fakeAuth, renderAppSignedIn, signedInBackend } from "./helpers";

const actual = await vi.importActual<typeof import("../auth/supabaseClient")>("../auth/supabaseClient");
const KEY = actual.AUTH_STORAGE_KEY;
const STORED = JSON.stringify({ access_token: "fake-access-token", refresh_token: "fake-refresh-token" });

describe("session storage shared by every tab", () => {
    test("the session is written to localStorage, never sessionStorage", () => {
        actual.sessionStore.setItem(KEY, STORED);
        expect(window.localStorage.getItem(KEY)).toBe(STORED);
        expect(window.sessionStorage.getItem(KEY)).toBeNull();
        expect(actual.sessionStore.getItem(KEY)).toBe(STORED);
    });

    test("a tab signed in before the change keeps its session: it moves from sessionStorage to localStorage", () => {
        window.sessionStorage.setItem(KEY, STORED);
        expect(actual.sessionStore.getItem(KEY)).toBe(STORED);
        expect(window.localStorage.getItem(KEY)).toBe(STORED);
        expect(window.sessionStorage.getItem(KEY)).toBeNull();
    });

    test("localStorage wins over an old sessionStorage copy, which is left for removeItem", () => {
        window.localStorage.setItem(KEY, STORED);
        window.sessionStorage.setItem(KEY, "older");
        expect(actual.sessionStore.getItem(KEY)).toBe(STORED);
    });

    test("no stored session: getItem returns null", () => {
        expect(actual.sessionStore.getItem(KEY)).toBeNull();
    });

    test("removeItem clears both stores", () => {
        window.localStorage.setItem(KEY, STORED);
        window.sessionStorage.setItem(KEY, STORED);
        actual.sessionStore.removeItem(KEY);
        expect(window.localStorage.getItem(KEY)).toBeNull();
        expect(window.sessionStorage.getItem(KEY)).toBeNull();
    });

    test("another tab removing the session from localStorage signs this tab out locally", () => {
        const signOut = vi.fn(async () => ({ error: null }));
        const stop = actual.signOutWhenClearedElsewhere({ signOut } as never);
        try {
            window.dispatchEvent(new StorageEvent("storage", { key: KEY, oldValue: STORED, newValue: STORED, storageArea: window.localStorage }));
            window.dispatchEvent(new StorageEvent("storage", { key: "other.key", oldValue: STORED, newValue: null, storageArea: window.localStorage }));
            window.dispatchEvent(new StorageEvent("storage", { key: KEY, oldValue: STORED, newValue: null, storageArea: window.sessionStorage }));
            expect(signOut).not.toHaveBeenCalled();
            window.dispatchEvent(new StorageEvent("storage", { key: KEY, oldValue: STORED, newValue: null, storageArea: window.localStorage }));
            expect(signOut).toHaveBeenCalledTimes(1);
            expect(signOut).toHaveBeenCalledWith({ scope: "local" });
        } finally {
            stop();
        }
        window.dispatchEvent(new StorageEvent("storage", { key: KEY, oldValue: STORED, newValue: null, storageArea: window.localStorage }));
        expect(signOut).toHaveBeenCalledTimes(1);
    });

    test("a sign-out announced by another tab takes this tab to the login page", async () => {
        signedInBackend();
        await renderAppSignedIn("/");
        fakeAuth.expireSession();
        expect(await screen.findByRole("heading", { name: "Sign in to EMOPS" }, RENDER_STEP)).toBeInTheDocument();
    });
});

describe("header Back button", () => {
    const backButton = () => screen.getByRole("button", { name: "Back" });
    const current = () => within(screen.getByRole("navigation", { name: "Main navigation" })).getByRole("link", { current: "page" });

    test("is disabled on the first page of the session, with a title", async () => {
        signedInBackend();
        await renderAppSignedIn("/");
        expect(backButton()).toBeDisabled();
        expect(backButton()).toHaveAttribute("title", "Go back to the previous page");
    });

    test("after A -> B -> C one click lands on B (one step), and back on A it is disabled again", async () => {
        signedInBackend();
        const user = userEvent.setup();
        await renderAppSignedIn("/");
        const nav = screen.getByRole("navigation", { name: "Main navigation" });
        expect(current()).toHaveTextContent("Overview");

        await user.click(within(nav).getByRole("link", { name: "Audit Logs" }));
        await waitFor(() => expect(current()).toHaveTextContent("Audit Logs"));
        expect(backButton()).toBeEnabled();
        await user.click(within(nav).getByRole("link", { name: "Settings" }));
        await waitFor(() => expect(current()).toHaveTextContent("Settings"));

        await user.click(backButton());
        await waitFor(() => expect(current()).toHaveTextContent("Audit Logs"));
        expect(backButton()).toBeEnabled();

        await user.click(backButton());
        await waitFor(() => expect(current()).toHaveTextContent("Overview"));
        expect(backButton()).toBeDisabled();
    });
});
