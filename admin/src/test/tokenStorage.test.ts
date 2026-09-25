import { afterEach, describe, expect, test, vi } from "vitest";
import { clearToken, readToken, saveToken, tokenExpiresAt } from "../auth/tokenStorage";
import { fakeJwt } from "./helpers";

describe("tokenStorage", () => {
    afterEach(() => clearToken());

    test("save, read and clear use sessionStorage", () => {
        saveToken("a.b.c");
        expect(window.sessionStorage.getItem("emlynk.admin.token")).toBe("a.b.c");
        expect(readToken()).toBe("a.b.c");
        clearToken();
        expect(readToken()).toBeNull();
    });

    test("keeps working in memory when sessionStorage is unavailable", () => {
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
        saveToken("x.y.z");
        expect(readToken()).toBe("x.y.z");
    });

    test("reads the expiry from the JWT payload", () => {
        const expiresAt = tokenExpiresAt(fakeJwt(3600));
        expect(expiresAt).toBeGreaterThan(Date.now() + 3500_000);
        expect(tokenExpiresAt("not-a-jwt")).toBeNull();
        expect(tokenExpiresAt("a.@@@.c")).toBeNull();
    });
});
