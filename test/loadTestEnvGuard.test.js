// The load-test environment guard (scripts/loadtest/loadTestEnv.mjs): load tests run only on
// .env.loadtest, never fall back to .env, and refuse a project shared with another env file.
// Synthetic env files in a temp directory; no network, no database, no real credentials.
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LoadTestGuardError, PROFILE, databaseRef, loadLoadTestEnv, parseEnvText, supabaseRef, validateLoadTestEnv } from "../scripts/loadtest/loadTestEnv.mjs";

const POOLER = (ref, secret = "s3cret-pass") => `postgresql://postgres.${ref}:${secret}@aws-0-test-1.pooler.supabase.com:5432/postgres`;
const loadtestVars = (ref = "loadtestref", extra = {}) => ({
    DATABASE_URL: POOLER(ref), SUPABASE_URL: `https://${ref}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", SUPABASE_BUCKET: "bucket",
    DATABASE_POOL_MAX: "5", LOAD_TEST_MODE: "false", SHEET_SYNC_ENABLED: "true", ...extra,
});
const write = (dir, name, vars) => fs.writeFileSync(path.join(dir, name), Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n"));

const dirs = [];
const makeRoot = (files = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadtest-guard-"));
    dirs.push(dir);
    for (const [name, vars] of Object.entries(files)) write(dir, name, vars);
    return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const abortsWith = (fn, pattern) => assert.throws(fn, (error) => error instanceof LoadTestGuardError && pattern.test(error.message));

describe("load-test environment guard", () => {
    test("a missing .env.loadtest aborts; it never falls back to .env", () => {
        const root = makeRoot({ ".env": loadtestVars("devref") });
        abortsWith(() => validateLoadTestEnv({ root, checkGit: false }), /\.env\.loadtest is missing/);
    });

    test("a missing required variable aborts, naming the variable", () => {
        const vars = loadtestVars(); delete vars.SUPABASE_SERVICE_ROLE_KEY;
        abortsWith(() => validateLoadTestEnv({ root: makeRoot({ ".env.loadtest": vars }), checkGit: false }), /missing: SUPABASE_SERVICE_ROLE_KEY/);
    });

    test("the same project as .env (or another local env file) aborts, naming the project ref only", () => {
        for (const other of [".env", ".env.local", ".env.preview", ".env.production"]) {
            const root = makeRoot({ ".env.loadtest": loadtestVars("sharedref"), [other]: loadtestVars("sharedref") });
            assert.throws(() => validateLoadTestEnv({ root, checkGit: false }), (error) => {
                assert.ok(error instanceof LoadTestGuardError);
                assert.match(error.message, new RegExp(`sharedref.*${other.replace(".", "\\.")}`));
                assert.doesNotMatch(error.message, /s3cret-pass|service-role-secret/);
                return true;
            });
        }
    });

    test("only the database matching .env's Supabase URL also aborts", () => {
        const root = makeRoot({ ".env.loadtest": loadtestVars("loadtestref"), ".env": { SUPABASE_URL: "https://loadtestref.supabase.co" } });
        abortsWith(() => validateLoadTestEnv({ root, checkGit: false }), /same project as in \.env/);
    });

    test("DATABASE_URL and SUPABASE_URL must be the same Supabase project", () => {
        const vars = loadtestVars("one", { SUPABASE_URL: "https://two.supabase.co" });
        abortsWith(() => validateLoadTestEnv({ root: makeRoot({ ".env.loadtest": vars }), checkGit: false }), /different Supabase projects/);
    });

    test("a different project passes; the registration profile is forced and overrides are reported (not secrets)", () => {
        const root = makeRoot({ ".env.loadtest": loadtestVars("loadtestref"), ".env": loadtestVars("devref") });
        const { vars, summary } = validateLoadTestEnv({ root, checkGit: false });
        assert.equal(summary.projectRef, "loadtestref");
        assert.deepEqual(summary.comparedWith, [".env"]);
        for (const [name, value] of Object.entries(PROFILE)) assert.equal(vars[name], value, name);
        assert.deepEqual(PROFILE, { DATABASE_POOL_MAX: "15", LOAD_TEST_MODE: "true", SHEET_SYNC_ENABLED: "false" });
        assert.equal(summary.overridden.length, 3);
        assert.doesNotMatch(JSON.stringify(summary), /s3cret-pass|service-role-secret/);
    });

    test("loading points dotenv at .env.loadtest, applies the profile and removes every Sheet target", () => {
        const saved = { ...process.env };
        try {
            Object.assign(process.env, { SHEET_SPREADSHEET_ID: "real-sheet", SHEET_TAB_NAME: "real-tab", GOOGLE_APPLICATION_CREDENTIALS: "key.json" });
            const root = makeRoot({ ".env.loadtest": loadtestVars("loadtestref"), ".env": loadtestVars("devref") });
            const lines = [];
            loadLoadTestEnv({ root, checkGit: false, log: (line) => lines.push(line) });
            assert.equal(process.env.DOTENV_CONFIG_PATH, path.join(root, ".env.loadtest"));
            assert.deepEqual([process.env.DATABASE_POOL_MAX, process.env.LOAD_TEST_MODE, process.env.SHEET_SYNC_ENABLED], ["15", "true", "false"]);
            assert.deepEqual(["SHEET_SPREADSHEET_ID", "SHEET_TAB_NAME", "GOOGLE_APPLICATION_CREDENTIALS"].filter((name) => name in process.env), []);
            assert.ok(lines.some((line) => /loadtestref/.test(line)));
            assert.doesNotMatch(lines.join("\n"), /s3cret-pass|service-role-secret/);
        } finally {
            for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
            Object.assign(process.env, saved);
        }
    });

    test("project refs are read from pooler / direct connection strings and API URLs only", () => {
        assert.equal(databaseRef(POOLER("abc123")), "abc123");
        assert.equal(databaseRef("postgresql://postgres:pw@db.abc123.supabase.co:5432/postgres"), "abc123");
        assert.equal(databaseRef("postgresql://postgres:pw@localhost:5432/db"), null);
        assert.equal(supabaseRef("https://abc123.supabase.co"), "abc123");
        assert.equal(supabaseRef("https://example.com"), null);
        assert.deepEqual(parseEnvText("# c\nA=1\nexport B=\"two\"\n C = 'three' \n"), { A: "1", B: "two", C: "three" });
    });

    test("the real .env.loadtest of this repository is accepted (when present), and is git-ignored and untracked", { skip: !fs.existsSync(path.join(process.cwd(), ".env.loadtest")) }, () => {
        const { summary } = validateLoadTestEnv();
        assert.ok(summary.projectRef);
        assert.equal(summary.profile.SHEET_SYNC_ENABLED, "false");
    });
});
