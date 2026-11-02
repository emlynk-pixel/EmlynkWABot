// Convert the accounts that still hold the retired MANAGER role (src/services/retiredRoleService.js).
//
//   npm run user:migrate-manager                                   list them; changes nothing
//   npm run user:migrate-manager -- --apply --owner <admin_id>     convert them to ADMIN
//   ... --apply --owner <admin_id> --to ANALYST                    another supported role instead
//
// Without --apply it only prints how many accounts hold MANAGER (IDs and statuses) and the
// database host it read. --apply converts all of them in one transaction, as the ACTIVE OWNER
// <admin_id> (written in each UPDATE_USER_ROLE audit entry). The default target is ADMIN: ADMIN
// already holds everything a MANAGER could do. Run it in each environment (dev, stage, prod)
// before or when the release that retires MANAGER is deployed; running it again changes nothing.
// Needs DATABASE_URL (server only). Prints IDs, statuses and the host only; never an email.

import "dotenv/config";
import { parseArgs } from "node:util";

import { RETIRED_ROLES } from "../src/middleware/requireRole.js";
import { DEFAULT_REPLACEMENT_ROLE, RetiredRoleError, convertRetiredRole, findRetiredRoleAccounts } from "../src/services/retiredRoleService.js";

const RETIRED = RETIRED_ROLES.MANAGER;

function databaseHost() {
    try {
        return new URL(process.env.DATABASE_URL).host;
    } catch {
        return "(DATABASE_URL not set or not a URL)";
    }
}

async function main(prisma) {
    const { values } = parseArgs({
        options: {
            apply: { type: "boolean", default: false },
            owner: { type: "string" },
            to: { type: "string", default: DEFAULT_REPLACEMENT_ROLE[RETIRED] },
        },
        strict: true,
    });
    console.log(`Database: ${databaseHost()}`);
    const accounts = await findRetiredRoleAccounts({ db: prisma, retiredRole: RETIRED });
    console.log(`Accounts with role ${RETIRED}: ${accounts.length}`);
    for (const account of accounts) console.log(`  userId=${account.adminId}, status=${account.status}`);
    if (!values.apply) {
        if (accounts.length) console.log(`Dry run: nothing changed. Re-run with --apply --owner <admin_id> to convert them to ${values.to}.`);
        return;
    }
    const converted = await convertRetiredRole({ db: prisma, retiredRole: RETIRED, replacementRole: values.to, actorId: values.owner });
    console.log(`Converted ${converted.length} account(s) from ${RETIRED} to ${values.to}.`);
}

let exitCode = 0;
const { default: prisma } = await import("../src/config/prisma.js");
try {
    await main(prisma);
} catch (error) {
    // Validation messages are safe to show; anything else is reported by type only.
    const message = error instanceof RetiredRoleError || error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? error.message
        : `Failed (${error?.name ?? "Error"})`;
    console.error(`Nothing converted: ${message}`);
    exitCode = 1;
} finally {
    await prisma.$disconnect().catch(() => {});
}
process.exitCode = exitCode;
