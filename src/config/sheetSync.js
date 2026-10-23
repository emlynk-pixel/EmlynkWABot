// Google Sheet operational mirror: configuration and the write safety gate
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Section 11.6).
//
// The target is the real operational Sheet; there is no test copy. Writing
// is therefore OFF unless SHEET_SYNC_ENABLED is explicitly "true":
//   missing           -> disabled
//   "false"           -> disabled
//   anything else     -> disabled (and reported as invalid)
//   "true" (any case) -> enabled
// Local development, tests and previews stay disabled unless someone sets it.
//
// Authentication is the runtime identity through Application Default
// Credentials (Cloud Run's attached service account). No key file and no
// private key: GOOGLE_APPLICATION_CREDENTIALS must not be set for this
// feature. Problems name variables only, never their values.

import { BUSINESS_TIME_ZONE } from "../utils/businessDay.js";

export const SHEET_SYNC_GATE = Object.freeze({ ENABLED: "ENABLED", DISABLED: "DISABLED" });

// Why the gate is in its state: no value, "false", an unusable value, "true".
export const SHEET_SYNC_GATE_REASON = Object.freeze({
    MISSING: "MISSING",
    FALSE: "FALSE",
    INVALID: "INVALID",
    TRUE: "TRUE",
});

function gateFrom(value) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return { enabled: false, gateReason: SHEET_SYNC_GATE_REASON.MISSING };
    }
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "true") return { enabled: true, gateReason: SHEET_SYNC_GATE_REASON.TRUE };
    if (normalized === "false") return { enabled: false, gateReason: SHEET_SYNC_GATE_REASON.FALSE };
    return { enabled: false, gateReason: SHEET_SYNC_GATE_REASON.INVALID };
}

const isSet = (value) => typeof value === "string" && value.trim() !== "";

// ---------------------------------------------------------------- Sync Destination
//
// The Google Sheets the mirror can write to (Settings -> Google Sheet Sync ->
// Sync Destination). Configured on the sheet-sync worker only; full
// spreadsheet IDs never leave it (the worker publishes publicDestination()
// metadata to sheet_sync_state for the Admin page).
//
//   SHEET_SYNC_DESTINATIONS  optional JSON array, first entry = default:
//     [{"key":"operational","name":"Emlynk Candidate Operational Mirror",
//       "spreadsheetId":"…","tabName":"Emlynk Candidate Operational Mirror"}]
//     key: 1-40 lowercase letters, digits or "-" (stable; stored as the
//     active destination); name: 1-100 characters (shown in Settings);
//     tabName: matched exactly, like SHEET_TAB_NAME.
//   Not set: one destination from SHEET_SPREADSHEET_ID / SHEET_TAB_NAME,
//   key "default", named after its tab (the deployment before this feature).
//
// Which one is active is stored in sheet_sync_state.active_destination_key
// (null = the first); an ADMIN switches it, and the worker activates the new
// one only after validating its access and headers.
export const DEFAULT_DESTINATION_KEY = "default";
export const MAX_SHEET_SYNC_DESTINATIONS = 20;
const DESTINATION_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{10,200}$/;
export const isValidDestinationKey = (value) => typeof value === "string" && DESTINATION_KEY.test(value);

function readDestinations(env) {
    if (!isSet(env.SHEET_SYNC_DESTINATIONS)) {
        if (!isSet(env.SHEET_SPREADSHEET_ID) || !isSet(env.SHEET_TAB_NAME)) return { destinations: [], fromList: false, problems: [] };
        return {
            destinations: [Object.freeze({ key: DEFAULT_DESTINATION_KEY, name: env.SHEET_TAB_NAME.trim(), spreadsheetId: env.SHEET_SPREADSHEET_ID.trim(), tabName: env.SHEET_TAB_NAME })],
            fromList: false,
            problems: [],
        };
    }
    const invalid = (detail) => ({ destinations: [], fromList: true, problems: [`SHEET_SYNC_DESTINATIONS ${detail}`] });
    let parsed;
    try {
        parsed = JSON.parse(env.SHEET_SYNC_DESTINATIONS);
    } catch {
        return invalid("must be a JSON array");
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_SHEET_SYNC_DESTINATIONS) {
        return invalid(`must be a JSON array of 1 to ${MAX_SHEET_SYNC_DESTINATIONS} destinations`);
    }
    const destinations = [];
    for (const [index, entry] of parsed.entries()) {
        const at = `entry ${index + 1}`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalid(`${at} must be an object`);
        if (!isValidDestinationKey(entry.key)) return invalid(`${at}: key must be 1-40 lowercase letters, digits or "-"`);
        if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.trim().length > 100) return invalid(`${at}: name must be 1-100 characters`);
        if (typeof entry.spreadsheetId !== "string" || !SPREADSHEET_ID.test(entry.spreadsheetId.trim())) return invalid(`${at}: spreadsheetId is not a spreadsheet ID`);
        if (typeof entry.tabName !== "string" || !entry.tabName.trim() || entry.tabName.length > 100) return invalid(`${at}: tabName must be 1-100 characters`);
        if (destinations.some((d) => d.key === entry.key)) return invalid(`${at}: key "${entry.key}" is used twice`);
        destinations.push(Object.freeze({ key: entry.key, name: entry.name.trim(), spreadsheetId: entry.spreadsheetId.trim(), tabName: entry.tabName }));
    }
    return { destinations, fromList: true, problems: [] };
}

// ---------------------------------------------------------------- Candidate Form Submissions tab
//
// The Candidate Form submissions go to their own tab of the SAME spreadsheet (the active Sync
// Destination's), never to the operational mirror's tab. SHEET_FORM_SUBMISSIONS_TAB_NAME overrides
// the tab's name (matched exactly, like SHEET_TAB_NAME). Writing is behind the same gate
// (SHEET_SYNC_ENABLED) as the mirror.
export const DEFAULT_FORM_SUBMISSIONS_TAB = "Candidate Form Submissions";
export function readFormSubmissionSheetConfig(env = process.env) {
    const problems = [];
    let tabName = DEFAULT_FORM_SUBMISSIONS_TAB;
    if (isSet(env.SHEET_FORM_SUBMISSIONS_TAB_NAME)) {
        if (env.SHEET_FORM_SUBMISSIONS_TAB_NAME.length > 100) problems.push("SHEET_FORM_SUBMISSIONS_TAB_NAME must be 1-100 characters");
        else tabName = env.SHEET_FORM_SUBMISSIONS_TAB_NAME;
    }
    return Object.freeze({ tabName, problems: Object.freeze(problems) });
}

// What the Admin page may know about a destination: never the full ID.
export function publicDestination(destination) {
    return { key: destination.key, name: destination.name, hint: `…${destination.spreadsheetId.slice(-6)}`, tabName: destination.tabName };
}

// The destination for a stored key: null (nothing chosen yet) = the first
// (default) one; a key no longer configured = null (runs then fail with
// DESTINATION_NOT_CONFIGURED instead of writing to another Sheet).
export function resolveDestination(destinations, key) {
    if (key === null || key === undefined) return destinations[0] ?? null;
    return destinations.find((d) => d.key === key) ?? null;
}

// The Sheet sync settings from the environment. Never throws; `problems`
// lists what would stop an enabled sync from working.
export function readSheetSyncConfig(env = process.env) {
    const { enabled, gateReason } = gateFrom(env.SHEET_SYNC_ENABLED);
    const problems = [];
    if (gateReason === SHEET_SYNC_GATE_REASON.INVALID) {
        problems.push("SHEET_SYNC_ENABLED must be true or false");
    }
    const destinations = readDestinations(env);
    problems.push(...destinations.problems);
    if (enabled && !destinations.fromList) {
        if (!isSet(env.SHEET_SPREADSHEET_ID)) problems.push("SHEET_SPREADSHEET_ID is missing");
        if (!isSet(env.SHEET_TAB_NAME)) problems.push("SHEET_TAB_NAME is missing");
    }
    // The default destination (the first) is also the plain spreadsheetId /
    // tabName, so every existing caller keeps working unchanged.
    const first = destinations.destinations[0] ?? null;
    if (isSet(env.GOOGLE_APPLICATION_CREDENTIALS)) {
        problems.push("GOOGLE_APPLICATION_CREDENTIALS must not be set: the Sheet sync uses the runtime service identity, not a key file");
    }
    return Object.freeze({
        enabled,
        gate: enabled ? SHEET_SYNC_GATE.ENABLED : SHEET_SYNC_GATE.DISABLED,
        gateReason,
        spreadsheetId: destinations.fromList ? first?.spreadsheetId ?? null : (isSet(env.SHEET_SPREADSHEET_ID) ? env.SHEET_SPREADSHEET_ID.trim() : null),
        // Not trimmed inside: the tab name must match the Sheet exactly.
        tabName: destinations.fromList ? first?.tabName ?? null : (isSet(env.SHEET_TAB_NAME) ? env.SHEET_TAB_NAME : null),
        destinations: Object.freeze(destinations.destinations),
        problems: Object.freeze(problems),
    });
}

export const isSheetSyncEnabled = (env = process.env) => readSheetSyncConfig(env).enabled;

// ---------------------------------------------------------------- worker tuning

// Operational tunables of the sheet-sync worker (src/sheetSyncWorker.js).
// None of them can enable writing. A missing value uses the default; an
// unusable one also uses the default and is reported in `problems` (by
// variable name only). The schedule of reconciliations is NOT a tunable:
// SHEET_SYNC_SCHEDULE below, run by Cloud Scheduler.
// SHEET_SYNC_BATCH_SIZE and SHEET_SYNC_MAX_RETRIES belonged to the real-time
// queue processing, which the worker no longer does; they are still read so
// an existing deployment's environment stays valid, and have no effect.
const TUNABLES = Object.freeze({
    pollIntervalMs: { name: "SHEET_SYNC_POLL_INTERVAL_MS", default: 10_000, min: 1_000, max: 600_000, integer: true },
    batchSize: { name: "SHEET_SYNC_BATCH_SIZE", default: 25, min: 1, max: 200, integer: true },
    maxRetries: { name: "SHEET_SYNC_MAX_RETRIES", default: 5, min: 0, max: 20, integer: true },
    deletionGuardMax: { name: "SHEET_SYNC_DELETION_GUARD_MAX", default: 10, min: 0, max: 100_000, integer: true },
    deletionGuardFraction: { name: "SHEET_SYNC_DELETION_GUARD_FRACTION", default: 0.05, min: 0, max: 1, integer: false },
});

export const SHEET_SYNC_TUNING_DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(TUNABLES).map(([key, t]) => [key, t.default])));

export function readSheetSyncTuning(env = process.env) {
    const problems = [];
    const values = {};
    for (const [key, t] of Object.entries(TUNABLES)) {
        const raw = env[t.name];
        if (!isSet(raw)) {
            values[key] = t.default;
            continue;
        }
        const value = Number(raw.trim());
        const valid = Number.isFinite(value) && (!t.integer || Number.isInteger(value)) && value >= t.min && value <= t.max;
        if (!valid) problems.push(`${t.name} must be ${t.integer ? "a whole number" : "a number"} from ${t.min} to ${t.max}`);
        values[key] = valid ? value : t.default;
    }
    const pilot = parsePilotCandidateIds(env.SHEET_SYNC_PILOT_CANDIDATE_IDS);
    if (pilot.problem) problems.push(pilot.problem);
    return Object.freeze({ ...values, maxAttempts: values.maxRetries + 1, pilotCandidateIds: pilot.ids, problems: Object.freeze(problems) });
}

// The automatic synchronization schedule: a full database -> Sheet
// reconciliation at 06:00, 12:00 and 18:00 Sri Lanka time, one Cloud
// Scheduler job calling the worker's POST /tasks/reconcile (OIDC-
// authenticated). Nothing syncs in real time: database changes wait for the
// next scheduled run or a manual Sync Now. Asia/Colombo is the project's
// operational time zone (src/utils/businessDay.js); Cloud Scheduler applies
// it, so the server's own time zone never matters.
// The deployment commands (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md,
// Section 24.9) use exactly these values; a test keeps them in step.
export const SHEET_SYNC_SCHEDULE = Object.freeze({
    jobName: "emlynk-sheet-sync-reconcile",
    cron: "0 6,12,18 * * *",
    timeZone: BUSINESS_TIME_ZONE,
    times: Object.freeze(["06:00", "12:00", "18:00"]),
    httpMethod: "POST",
    path: "/tasks/reconcile",
});

// SHEET_SYNC_PILOT_CANDIDATE_IDS: the controlled first-write pilot
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Section 24.10). A comma-
// separated list of candidate unique IDs. While it is set, a reconciliation
// writes ONLY these candidates (every other candidate is compared but not
// written, and no row is marked inactive), so enabling writes can't mirror
// the whole database at once. Unset = normal operation. It never enables
// writing.
export const MAX_PILOT_CANDIDATES = 20;
function parsePilotCandidateIds(raw) {
    if (!isSet(raw)) return { ids: null };
    const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
    if (!ids.length || ids.length > MAX_PILOT_CANDIDATES || !ids.every((id) => /^[A-Za-z0-9_-]{1,40}$/.test(id))) {
        // Fail closed: an unusable pilot list stops the worker from starting.
        return { ids: null, problem: `SHEET_SYNC_PILOT_CANDIDATE_IDS must be 1 to ${MAX_PILOT_CANDIDATES} comma-separated candidate unique IDs` };
    }
    return { ids: Object.freeze(ids) };
}

// What the Admin status page may show about the target: the tab name and the
// last characters of the spreadsheet ID, never the whole identifier.
export function sheetTargetHint({ spreadsheetId, tabName }) {
    if (!spreadsheetId || !tabName) return null;
    return `…${spreadsheetId.slice(-6)} / ${tabName}`;
}
