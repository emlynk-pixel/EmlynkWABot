-- Google Sheet Sync: Sync Destination (Settings -> Google Sheet Sync).
-- Additive only: four nullable columns on the two existing Sheet Sync
-- tables. No new table, no row changed. With every column empty the worker
-- behaves exactly as before: the destination is SHEET_SPREADSHEET_ID /
-- SHEET_TAB_NAME (or the first entry of SHEET_SYNC_DESTINATIONS).
--
-- sheet_sync_state.destinations             the configured destinations as the
--                                           worker publishes them: key, name,
--                                           short hint, tab name. Never a full
--                                           spreadsheet ID.
-- sheet_sync_state.active_destination_key   the destination every run uses;
--                                           NULL = the first (default) one.
-- sheet_sync_state.requested_destination_key a switch an ADMIN requested; it
--                                           becomes active only after the worker
--                                           validated the Sheet's access and
--                                           headers.
-- sheet_sync_runs.destination_key           the destination a run used.

-- AlterTable
ALTER TABLE "sheet_sync_runs" ADD COLUMN "destination_key" TEXT;

-- AlterTable
ALTER TABLE "sheet_sync_state" ADD COLUMN "active_destination_key" TEXT,
ADD COLUMN "destinations" JSONB,
ADD COLUMN "requested_destination_key" TEXT;
