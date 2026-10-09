import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { setApiAccessToken } from "../api/client";
import { fakeAuth } from "./fakeSupabase";

// Supabase Auth is an in-memory fake in every test (test/fakeSupabase.ts):
// nothing contacts Supabase. The real module's other exports stay real.
vi.mock("../auth/supabaseClient", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../auth/supabaseClient")>();
    const { fakeAuth: auth } = await import("./fakeSupabase");
    return { ...actual, getAuthClient: () => auth };
});

afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    window.localStorage.clear();
    fakeAuth.reset();
    setApiAccessToken(null);
    window.location.hash = "";
    vi.unstubAllGlobals();
});
