# Seed Data Setup

## Objective
Add repeatable sample data to the PostgreSQL database for development and testing before WhatsApp, OCR, and object-storage integrations are implemented.

## Changes Made
- Added a Prisma seed script.
- Configured the Prisma 7 seed command in `prisma7.config.ts`.
- Added PostgreSQL driver support for Prisma.
- Generated the Prisma client.
- Seeded sample Admin, User, and Document records.
- Verified that the seed command completed successfully.

## Seed Configuration

`prisma7.config.ts`:

```ts
migrations: {
  path: "prisma/migrations",
  seed: "node prisma/seed.js",
},
```

## Packages Added

```bash
npm install @prisma/adapter-pg pg
```

## Prisma Client Generation

```bash
npx prisma generate
```

## Seed Execution

```bash
npx prisma db seed
```

Successful result:

```text
Seed completed
The seed command has been executed.
```

## Sample Records

### Admin
- Admin ID: `ADM001`
- Name: `System Admin`
- Email: `admin@emlynk.com`
- Role: `ADMIN`
- Status: `ACTIVE`

### User
- Passport ID: `P1234567`
- Unique ID: `0001`
- First Name: `Test`
- Other Name: `User`
- WhatsApp Number: `94770000000`
- Contact Number: `94770000000`
- Job: `Technician`

### Document
- Document ID: `DOC001`
- Passport ID: `P1234567`
- Document Type: `PASSPORT`
- Original Filename: `passport-original.pdf`
- Stored Filename: `passport.pdf`
- Storage Path: `clients/P1234567/passport/passport.pdf`
- MIME Type: `application/pdf`
- Processing Status: `PROCESSED`
- Verification Status: `VERIFIED`
- OCR Confidence: `0.98`

## Why `upsert` Is Used

The seed script uses Prisma `upsert`.

```text
Record exists -> update/keep existing record
Record does not exist -> create the record
```

This makes the seed process repeatable and helps avoid duplicate test records.

## Verification

Inspect the database with:

```bash
npx prisma studio
```

Verify that the Admin, User, and Document sample records are present.

## Git Checkpoint

Recommended commit:

```bash
git add prisma/seed.js prisma7.config.ts package.json package-lock.json Docs/02-seed-data.md
git commit -m "feat: add initial database seed data"
git status
```
