// `prisma migrate deploy` against the LOAD-TEST database only.
//   npm run loadtest:migrate
// A plain `npx prisma migrate deploy` reads `.env` (prisma7.config.ts imports dotenv/config), i.e. the
// DEV database. This runs it through the load-test guard instead (loadTestEnv.mjs): DATABASE_URL is the
// one in `.env.loadtest`, dotenv is pointed at `.env.loadtest`, and it aborts if that project is the
// one in `.env`. It shows `migrate status` first. Never `migrate dev`, `reset` or `resolve`.

import { spawnSync } from "node:child_process";
import { REPO_ROOT, loadLoadTestEnv, LoadTestGuardError } from "./loadTestEnv.mjs";

try {
    loadLoadTestEnv({ log: (line) => console.log(line) });
} catch (error) {
    console.error(`[loadtest] ABORT: ${error instanceof LoadTestGuardError ? error.message : error.message}`);
    process.exit(2);
}

const prisma = (command) => spawnSync("npx", ["prisma", "migrate", command, "--config", "prisma7.config.ts"], { cwd: REPO_ROOT, stdio: "inherit", shell: process.platform === "win32" });

console.log("[loadtest] prisma migrate status (load-test database)");
prisma("status");
console.log("[loadtest] prisma migrate deploy (load-test database)");
const deploy = prisma("deploy");
process.exit(deploy.status ?? 1);
