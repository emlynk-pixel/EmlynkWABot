// Load-test environment guard (version/load-testing ONLY).
//
// Loads `.env.loadtest` explicitly and NEVER falls back to `.env`:
//   - aborts when `.env.loadtest` is missing, untracked-by-Git checks fail, or a required
//     variable is missing;
//   - aborts when the load-test database or Supabase project is the same as the one in `.env`
//     (or any other local env file), or when its own database and Supabase refs disagree;
//   - forces the registration-test profile (pool 15, LOAD_TEST_MODE on, Google Sheet sync off);
//   - points dotenv at `.env.loadtest` (DOTENV_CONFIG_PATH), so the app's `import "dotenv/config"`
//     can never read `.env`.
// Messages name variables and Supabase project refs only, never values.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LOAD_TEST_ENV_FILE = ".env.loadtest";

// Variables the load-test environment must define itself (the app validates the rest at startup).
export const REQUIRED_VARS = Object.freeze([
    "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_BUCKET",
]);

// The registration-test profile: forced, whatever the file says (non-secret settings).
export const PROFILE = Object.freeze({ DATABASE_POOL_MAX: "13", LOAD_TEST_MODE: "true", SHEET_SYNC_ENABLED: "false" });

// Local env files whose database / Supabase project the load test must NOT share.
const OTHER_ENV_FILES = Object.freeze([".env", ".env.local", ".env.preview", ".env.production"]);
// Variables that would point the Google Sheet sync at a real sheet: never present in a load test.
const SHEET_TARGET_VARS = Object.freeze(["SHEET_SPREADSHEET_ID", "SHEET_TAB_NAME", "GOOGLE_APPLICATION_CREDENTIALS"]);

export class LoadTestGuardError extends Error {
    constructor(message) {
        super(message);
        this.name = "LoadTestGuardError";
    }
}

export function parseEnvText(text) {
    const vars = {};
    for (const line of String(text).split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match || line.trimStart().startsWith("#")) continue;
        let value = match[2];
        if (/^".*"$|^'.*'$/.test(value)) value = value.slice(1, -1);
        vars[match[1]] = value;
    }
    return vars;
}

const readEnvFile = (file) => (fs.existsSync(file) ? parseEnvText(fs.readFileSync(file, "utf8")) : null);

// The Supabase project ref of a pooler / direct connection string, or null.
export function databaseRef(url) {
    try {
        const parsed = new URL(url);
        const user = decodeURIComponent(parsed.username);
        if (user.includes(".")) return user.split(".").slice(1).join(".");
        const direct = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(parsed.hostname);
        return direct ? direct[1] : null;
    } catch {
        return null;
    }
}

// The Supabase project ref of an API URL (https://<ref>.supabase.co), or null.
export function supabaseRef(url) {
    try {
        const host = new URL(url).hostname;
        return host.endsWith(".supabase.co") ? host.split(".")[0] : null;
    } catch {
        return null;
    }
}

function assertGitIgnored(root, file) {
    const git = (...args) => { try { execFileSync("git", args, { cwd: root, stdio: "ignore" }); return true; } catch { return false; } };
    if (!git("check-ignore", "-q", file)) throw new LoadTestGuardError(`${file} is not ignored by Git; refusing to continue.`);
    if (git("ls-files", "--error-unmatch", file)) throw new LoadTestGuardError(`${file} is tracked by Git; refusing to continue.`);
}

// Validates the load-test environment and returns { vars, summary }; does not touch process.env.
export function validateLoadTestEnv({ root = REPO_ROOT, checkGit = true } = {}) {
    const file = path.join(root, LOAD_TEST_ENV_FILE);
    const vars = readEnvFile(file);
    if (!vars) throw new LoadTestGuardError(`${LOAD_TEST_ENV_FILE} is missing. Load tests never fall back to .env.`);
    if (checkGit) assertGitIgnored(root, LOAD_TEST_ENV_FILE);

    const missing = REQUIRED_VARS.filter((name) => !vars[name]);
    if (missing.length) throw new LoadTestGuardError(`${LOAD_TEST_ENV_FILE} is missing: ${missing.join(", ")}.`);

    const dbRef = databaseRef(vars.DATABASE_URL);
    const apiRef = supabaseRef(vars.SUPABASE_URL);
    if (!dbRef) throw new LoadTestGuardError("DATABASE_URL in .env.loadtest is not a Supabase connection string; its project ref cannot be read.");
    if (!apiRef) throw new LoadTestGuardError("SUPABASE_URL in .env.loadtest is not a https://<ref>.supabase.co URL; its project ref cannot be read.");
    if (dbRef !== apiRef) {
        throw new LoadTestGuardError(`DATABASE_URL (project ${dbRef}) and SUPABASE_URL (project ${apiRef}) in .env.loadtest are different Supabase projects.`);
    }

    const compared = [];
    for (const name of OTHER_ENV_FILES) {
        const other = readEnvFile(path.join(root, name));
        if (!other) continue;
        const refs = [other.DATABASE_URL && databaseRef(other.DATABASE_URL), other.SUPABASE_URL && supabaseRef(other.SUPABASE_URL)].filter(Boolean);
        if (!refs.length) continue;
        compared.push(name);
        if (refs.includes(dbRef)) {
            throw new LoadTestGuardError(`The load-test project (${dbRef}) is the same project as in ${name}. Refusing to run a load test against it.`);
        }
    }

    const overridden = Object.entries(PROFILE).filter(([name, value]) => vars[name] !== value).map(([name, value]) => `${name}: ${vars[name] ?? "(unset)"} -> ${value}`);
    return {
        vars: { ...vars, ...PROFILE },
        file,
        summary: { projectRef: dbRef, comparedWith: compared, devEnvFound: compared.includes(".env"), overridden, profile: { ...PROFILE } },
    };
}

// Validates, then applies the load-test environment to process.env. After this, nothing in the
// process can read `.env`: dotenv is pointed at `.env.loadtest`, and every Sheet target is removed.
export function loadLoadTestEnv({ root = REPO_ROOT, checkGit = true, log = () => {} } = {}) {
    const { vars, file, summary } = validateLoadTestEnv({ root, checkGit });
    for (const [name, value] of Object.entries(vars)) process.env[name] = value;
    for (const name of SHEET_TARGET_VARS) delete process.env[name];
    process.env.DOTENV_CONFIG_PATH = file;
    process.env.DOTENV_CONFIG_QUIET = "true";
    log(`[loadtest] environment: ${LOAD_TEST_ENV_FILE} (project ${summary.projectRef}); not the project in ${summary.comparedWith.join(", ") || "any other env file"}`);
    if (!summary.devEnvFound) log("[loadtest] warning: no .env found, so the dev project could not be compared");
    log(`[loadtest] profile: DATABASE_POOL_MAX=${PROFILE.DATABASE_POOL_MAX} LOAD_TEST_MODE=${PROFILE.LOAD_TEST_MODE} SHEET_SYNC_ENABLED=${PROFILE.SHEET_SYNC_ENABLED}`);
    for (const change of summary.overridden) log(`[loadtest] profile override ${change}`);
    return summary;
}
