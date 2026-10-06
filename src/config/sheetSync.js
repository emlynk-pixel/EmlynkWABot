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
