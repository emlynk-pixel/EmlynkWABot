// The Admin Console's Content-Security-Policy header (vercel.json, source /admin(.*)).
// The xlsx reader of the Upload dialog unzips in a Web Worker created from a blob: URL; without
// worker-src 'self' blob: the browser blocks it (worker-src falls back to script-src 'self') and the
// dialog hung on "Reading and checking the sheet…" in production. This pins the one allowance and
// guards against widening anything else.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));

const adminPolicy = () => {
    const rule = vercel.headers.find((h) => h.source === "/admin(.*)");
    const value = rule?.headers.find((h) => h.key === "Content-Security-Policy")?.value;
    assert.ok(value, "the /admin header rule carries a Content-Security-Policy");
    return new Map(value.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name, values];
    }));
};

describe("Admin Console CSP", () => {
    test("worker-src allows exactly the app itself and blob: (the xlsx reader's worker)", () => {
        assert.deepEqual(adminPolicy().get("worker-src"), ["'self'", "blob:"]);
    });

    test("scripts are still same-origin only: no unsafe-eval, no unsafe-inline, no remote or wildcard source", () => {
        const policy = adminPolicy();
        assert.deepEqual(policy.get("script-src"), ["'self'"]);
        assert.deepEqual(policy.get("script-src-attr"), ["'none'"]);
        assert.deepEqual(policy.get("default-src"), ["'self'"]);
        assert.deepEqual(policy.get("object-src"), ["'none'"]);
        for (const [name, values] of policy) {
            if (name === "style-src") continue; // existing: https: and 'unsafe-inline' for styles only
            assert.ok(!values.some((v) => v === "'unsafe-eval'" || v === "'unsafe-inline'" || v === "*"), `${name} must not be widened`);
        }
    });

    test("connect-src is unchanged (same origin and Supabase only)", () => {
        assert.deepEqual(adminPolicy().get("connect-src"), ["'self'", "https://*.supabase.co"]);
    });
});
