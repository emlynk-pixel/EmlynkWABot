-- Optional passport details for candidates (all nullable; existing rows keep NULL).
ALTER TABLE "users" ADD COLUMN "nationality" TEXT,
ADD COLUMN "passport_issue_date" TIMESTAMP(3),
ADD COLUMN "sex" TEXT;
