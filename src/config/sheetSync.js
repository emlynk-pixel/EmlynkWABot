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

// The Sheet sync settings from the environment. Never throws; `problems`
// lists what would stop an enabled sync from working.
export function readSheetSyncConfig(env = process.env) {
    const { enabled, gateReason } = gateFrom(env.SHEET_SYNC_ENABLED);
    const problems = [];
    if (gateReason === SHEET_SYNC_GATE_REASON.INVALID) {
        problems.push("SHEET_SYNC_ENABLED must be true or false");
    }
    if (enabled) {
        if (!isSet(env.SHEET_SPREADSHEET_ID)) problems.push("SHEET_SPREADSHEET_ID is missing");
        if (!isSet(env.SHEET_TAB_NAME)) problems.push("SHEET_TAB_NAME is missing");
    }
    if (isSet(env.GOOGLE_APPLICATION_CREDENTIALS)) {
        problems.push("GOOGLE_APPLICATION_CREDENTIALS must not be set: the Sheet sync uses the runtime service identity, not a key file");
    }
    return Object.freeze({
        enabled,
        gate: enabled ? SHEET_SYNC_GATE.ENABLED : SHEET_SYNC_GATE.DISABLED,
        gateReason,
        spreadsheetId: isSet(env.SHEET_SPREADSHEET_ID) ? env.SHEET_SPREADSHEET_ID.trim() : null,
        // Not trimmed inside: the tab name must match the Sheet exactly.
        tabName: isSet(env.SHEET_TAB_NAME) ? env.SHEET_TAB_NAME : null,
        problems: Object.freeze(problems),
    });
}

export const isSheetSyncEnabled = (env = process.env) => readSheetSyncConfig(env).enabled;

// ---------------------------------------------------------------- worker tuning

// Operational tunables of the sheet-sync worker (src/sheetSyncWorker.js).
// None of them can enable writing. A missing value uses the default; an
// unusable one also uses the default and is reported in `problems` (by
// variable name only). The schedule of reconciliations is NOT here: it
// belongs to Cloud Scheduler (production daily, staging ~5 minutes).
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

// SHEET_SYNC_PILOT_CANDIDATE_IDS: the controlled first-write pilot
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Section 24.10). A comma-
// separated list of candidate unique IDs. While it is set, the worker syncs
// ONLY these candidates (every other queue item waits, untouched) and every
// reconciliation is a dry run, so enabling writes can't mirror the whole
// database at once. Unset = normal operation. It never enables writing.
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
