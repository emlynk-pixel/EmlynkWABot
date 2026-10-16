import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { clearSession } from "../session/tokenStore";

// Every test starts with no session, empty browser storage and the real fetch.
afterEach(() => {
    cleanup();
    clearSession();
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.cookie.split(";").forEach((cookie) => {
        document.cookie = `${cookie.split("=")[0].trim()}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    });
    delete document.documentElement.dataset.theme;
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
