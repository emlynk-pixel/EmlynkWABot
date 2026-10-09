// The browser Supabase client's configuration (auth/supabaseClient.ts, the
// real module: setup.ts only swaps getAuthClient for the fake). The admin app
// keeps no token of its own any more; Supabase stores the session.
import { describe, expect, test, vi } from "vitest";

const actual = await vi.importActual<typeof import("../auth/supabaseClient")>("../auth/supabaseClient");

const jwtWithRole = (role: string) => `x.${btoa(JSON.stringify({ role })).replace(/=+$/, "")}.y`;

describe("Supabase browser client configuration", () => {
    test("a secret / service-role key is never accepted in the browser", () => {
        expect(actual.isSecretKey("sb_secret_abc123")).toBe(true);
        expect(actual.isSecretKey(jwtWithRole("service_role"))).toBe(true);
        expect(actual.isSecretKey(jwtWithRole("anon"))).toBe(false);
        expect(actual.isSecretKey("sb_publishable_abc123")).toBe(false);
    });

    test("without public configuration, sign-in reports a configuration error instead of failing obscurely", () => {
        vi.stubEnv("VITE_SUPABASE_URL", "");
        vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
        expect(() => actual.getAuthClient()).toThrow(actual.SupabaseConfigError);
        vi.unstubAllEnvs();
    });

    test("a service-role key in the build configuration is refused", () => {
        vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
        vi.stubEnv("VITE_SUPABASE_ANON_KEY", "sb_secret_never_in_a_browser");
        expect(() => actual.getAuthClient()).toThrow(/secret key/);
        vi.unstubAllEnvs();
    });

    test("redirect URLs are built from this app's own origin and base path", () => {
        expect(actual.appUrl("reset-password")).toBe(`${window.location.origin}/admin/reset-password`);
        expect(actual.appUrl("/setup-password")).toBe(`${window.location.origin}/admin/setup-password`);
    });

    test("an expired invite/recovery link's error is read from the URL fragment", () => {
        expect(actual.authLinkError("#error=access_denied&error_code=otp_expired")).toBe("otp_expired");
        expect(actual.authLinkError("#error=access_denied")).toBe("access_denied");
        expect(actual.authLinkError("#access_token=abc&type=invite")).toBeNull();
        expect(actual.authLinkError("")).toBeNull();
    });

    test("the old application token key is never written", () => {
        expect(window.sessionStorage.getItem("emlynk.admin.token")).toBeNull();
        expect(actual.AUTH_STORAGE_KEY).toBe("emlynk.auth");
    });
});
