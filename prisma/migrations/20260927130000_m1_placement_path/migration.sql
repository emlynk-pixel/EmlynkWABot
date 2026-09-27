-- M1 critical fixes: repeatable storage copies. Additive only: one nullable
-- column on temporary_data; no existing column, constraint or row changes.
--   placement_path  the clients/ or pending/ object path the background
--                   worker was about to create, recorded (with its lease
--                   renewal) right before the copy. A retry after a crash
--                   reuses that object instead of creating a second copy.

-- AlterTable
ALTER TABLE "temporary_data" ADD COLUMN     "placement_path" TEXT;
