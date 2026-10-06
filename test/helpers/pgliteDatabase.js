// A real, throwaway PostgreSQL for tests that need real database semantics
// (triggers, partial unique indexes, transactions): PGlite (PostgreSQL
// compiled to WebAssembly, in this process), with every migration in
// prisma/migrations applied in order, served over the PostgreSQL wire
// protocol so the real Prisma client talks to it.
//
// Nothing here reads DATABASE_URL or .env: the Prisma client is built
// directly against the in-memory database, so a test can never reach a real
// (Supabase) database by mistake. Each call creates a fresh, empty database.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../generated/prisma/client.ts";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prisma", "migrations");

export function migrationNames() {
    return fs.readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{14}_/.test(name)).sort();
}

// Supabase's API roles and the table `prisma migrate deploy` creates itself;
// the migrations refer to both. The session time zone is UTC, as on Supabase:
// PGlite would otherwise take the host's zone, and the Prisma pg adapter
// misreads timestamptz values rendered with a non-UTC offset.
const PRELUDE = `
    SET TIME ZONE 'UTC';
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE "_prisma_migrations" ("id" VARCHAR(36) PRIMARY KEY);
`;

// { pg, prisma, close() }: pg runs raw SQL directly (PGlite), prisma is the
// real generated client. `upTo` stops after that migration (inclusive).
export async function createTestDatabase({ upTo = null } = {}) {
    const pg = await PGlite.create();
    await pg.exec(PRELUDE);
    for (const name of migrationNames()) {
        await pg.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"));
        if (name === upTo) break;
    }

    // PGlite is ONE session: Prisma gets exactly one client, never closed
    // while idle (pg would otherwise reconnect after 10 s, and the socket
    // server refuses a second connection while the old one is closing).
    const server = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1" });
    await server.start();
    const { port } = server.server.address();
    const url = `postgresql://postgres:test@127.0.0.1:${port}/postgres?sslmode=disable`;
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1, idleTimeoutMillis: 0 }) });

    return {
        pg,
        prisma,
        async close() {
            await prisma.$disconnect();
            await server.stop();
            await pg.close();
        },
    };
}
