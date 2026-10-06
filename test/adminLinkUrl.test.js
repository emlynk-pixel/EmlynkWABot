import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { AdminLinkConfigError, getAdminBaseUrl, getAdminResetUrl, getAdminSetupUrl } from "../src/services/emailService.js";

// Base URL of the admin app in emailed links (invitation setup, password
// reset). The admin app is served under /admin (vite base, router basename,
// vercel.json), so the link must contain /admin exactly once.

const PREVIEW = { VERCEL: "1", VERCEL_ENV: "preview" };
const TOKEN = "a".repeat(64);

describe("getAdminBaseUrl", () => {
    test("local development with nothing set uses the Vite dev server", () => {
        assert.equal(getAdminBaseUrl({}), "http://localhost:5173/admin");
    });

    test("local development may point at localhost explicitly", () => {
        assert.equal(getAdminBaseUrl({ APP_BASE_URL: "http://localhost:3000" }), "http://localhost:3000/admin");
    });

    test("ADMIN_SETUP_URL_BASE gets /admin exactly once, with or without it or a trailing slash", () => {
        for (const value of [
            "https://app.example.invalid",
            "https://app.example.invalid/",
            "https://app.example.invalid/admin",
            "https://app.example.invalid/admin/",
            "https://app.example.invalid/admin//",
            "  https://app.example.invalid/admin  ",
        ]) {
            assert.equal(getAdminBaseUrl({ ...PREVIEW, ADMIN_SETUP_URL_BASE: value }), "https://app.example.invalid/admin", value);
        }
    });

    test("APP_BASE_URL gets /admin exactly once", () => {
        assert.equal(getAdminBaseUrl({ ...PREVIEW, APP_BASE_URL: "https://app.example.invalid/" }), "https://app.example.invalid/admin");
        assert.equal(getAdminBaseUrl({ ...PREVIEW, APP_BASE_URL: "https://app.example.invalid/admin" }), "https://app.example.invalid/admin");
    });

    test("ADMIN_SETUP_URL_BASE wins over APP_BASE_URL; a blank one is ignored", () => {
        assert.equal(
            getAdminBaseUrl({ ...PREVIEW, ADMIN_SETUP_URL_BASE: "https://a.example.invalid", APP_BASE_URL: "https://b.example.invalid" }),
            "https://a.example.invalid/admin"
        );
        assert.equal(
            getAdminBaseUrl({ ...PREVIEW, ADMIN_SETUP_URL_BASE: "  ", APP_BASE_URL: "https://b.example.invalid" }),
            "https://b.example.invalid/admin"
        );
    });

    test("a deployment without a configured base fails instead of using localhost", () => {
        assert.throws(() => getAdminBaseUrl(PREVIEW), AdminLinkConfigError);
        assert.throws(() => getAdminBaseUrl({ NODE_ENV: "production" }), AdminLinkConfigError);
    });

    test("a deployment with a localhost base fails, naming the variable but not its value", () => {
        for (const env of [
            { ...PREVIEW, APP_BASE_URL: "http://localhost:3000" },
            { VERCEL: "1", VERCEL_ENV: "production", ADMIN_SETUP_URL_BASE: "http://127.0.0.1:5173/admin" },
            { NODE_ENV: "production", ADMIN_SETUP_URL_BASE: "http://localhost:5173/admin" },
        ]) {
            assert.throws(() => getAdminBaseUrl(env), (error) => {
                assert.ok(error instanceof AdminLinkConfigError);
                assert.match(error.message, /ADMIN_SETUP_URL_BASE|APP_BASE_URL/);
                assert.doesNotMatch(error.message, /localhost:|127\.0\.0\.1/);
                return true;
            });
        }
    });

    test("an invalid or non-http URL fails", () => {
        assert.throws(() => getAdminBaseUrl({ ADMIN_SETUP_URL_BASE: "not a url" }), AdminLinkConfigError);
        assert.throws(() => getAdminBaseUrl({ ADMIN_SETUP_URL_BASE: "ftp://app.example.invalid" }), AdminLinkConfigError);
    });
});

describe("emailed admin links", () => {
    test("deployed setup link is the public /admin/setup-password page with the token preserved", () => {
        const link = new URL(getAdminSetupUrl(TOKEN, { ...PREVIEW, ADMIN_SETUP_URL_BASE: "https://app.example.invalid/" }));
        assert.equal(link.origin, "https://app.example.invalid");
        assert.equal(link.pathname, "/admin/setup-password");
        assert.equal(link.searchParams.get("token"), TOKEN);
        assert.doesNotMatch(link.href, /localhost|\/admin\/admin/);
    });

    test("deployed reset link uses the same base", () => {
        const link = new URL(getAdminResetUrl(TOKEN, { ...PREVIEW, ADMIN_SETUP_URL_BASE: "https://app.example.invalid/admin" }));
        assert.equal(link.href, `https://app.example.invalid/admin/reset-password?token=${TOKEN}`);
    });
});
