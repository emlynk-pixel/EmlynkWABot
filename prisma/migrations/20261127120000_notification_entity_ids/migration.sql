-- What a notification is about (src/services/notificationEvents.js), so the app can open the
-- candidate or the job from it. Additive only: two nullable columns, no default, no backfill,
-- no index and no foreign key (a notification outlives a deleted candidate or job). Existing
-- rows keep NULL in both. Never shown in the title or message.
--   candidate_id  the candidate's passport_id (A1 for a single candidate, A4, E1, A5)
--   job_id        the job's id (C1, A5)

-- AlterTable
ALTER TABLE "notification" ADD COLUMN "candidate_id" TEXT;
ALTER TABLE "notification" ADD COLUMN "job_id" UUID;
