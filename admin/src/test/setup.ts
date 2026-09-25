import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.unstubAllGlobals();
});
