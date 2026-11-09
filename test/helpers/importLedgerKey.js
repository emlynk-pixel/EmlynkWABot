// Imports refuse to run without the change-ledger HMAC key (src/services/importLedgerKeys.js): there is no
// weaker fallback. Tests that run imports import this file, which gives the process a TEST-ONLY key. It never
// overrides a key already in the environment and is not a real secret (it appears in the repository).
export const TEST_LEDGER_SECRET = "test-only-import-ledger-secret-0123456789abcdef";
export const TEST_LEDGER_KEY_ID = "t1";

process.env.IMPORT_LEDGER_HMAC_SECRET ??= TEST_LEDGER_SECRET;
process.env.IMPORT_LEDGER_HMAC_KEY_ID ??= TEST_LEDGER_KEY_ID;
