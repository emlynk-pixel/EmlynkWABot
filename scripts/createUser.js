// Create (or link) an application user through Supabase Auth.
//
//   npm run user:create -- --name "Full Name" --email user@example.com [--role ADMIN]
//   npm run user:create -- --email user@example.com --link [--role MANAGER]
//
// Without --link: creates a Supabase Auth identity (email confirmed) with the
// password typed at a hidden prompt (asked twice; for automation it may come
// from the BOOTSTRAP_PASSWORD environment variable, never a command-line
// argument), and its ACTIVE public."user" row. The default role is ADMIN.
//
// With --link: creates the public."user" row for an existing Supabase Auth
// identity (found by email) that does not have one yet. An email whose row
// already exists (every row is linked to Supabase Auth) is refused, and
// nothing changes.
//
// The password goes to Supabase only. Only the user ID and status are printed.
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DATABASE_URL (server only).

import "dotenv/config";
import readline from "node:readline";
import { parseArgs } from "node:util";

import { provisionUser, UserProvisioningError } from "../src/services/userProvisioningService.js";

function promptHidden(question) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY) {
            reject(new UserProvisioningError("NO_TERMINAL", "No terminal for the password prompt; set BOOTSTRAP_PASSWORD instead"));
            return;
        }
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        let muted = false;
        rl._writeToOutput = (text) => {
            if (!muted) rl.output.write(text);
        };
        rl.question(question, (answer) => {
            rl.output.write("\n");
            rl.close();
            resolve(answer);
        });
        muted = true;
    });
}

async function readPassword() {
    if (process.env.BOOTSTRAP_PASSWORD) return process.env.BOOTSTRAP_PASSWORD;
    const password = await promptHidden("Password: ");
    const repeated = await promptHidden("Repeat password: ");
    if (password !== repeated) throw new UserProvisioningError("PASSWORD_MISMATCH", "Passwords do not match");
    return password;
}

async function main() {
    const { values } = parseArgs({
        options: {
            name: { type: "string" },
            email: { type: "string" },
            role: { type: "string" },
            link: { type: "boolean", default: false },
        },
        strict: true,
    });

    const password = values.link ? undefined : await readPassword();
    const [{ default: prisma }, { getSupabaseAuthAdmin }] = await Promise.all([
        import("../src/config/prisma.js"),
        import("../src/auth/supabaseAuthAdmin.js"),
    ]);
    const result = await provisionUser(
        { name: values.name, email: values.email, password, role: values.role, link: values.link },
        { db: prisma, authAdmin: await getSupabaseAuthAdmin() }
    );
    console.log(`User ${values.link ? "linked" : "created"}: userId=${result.userId}, status=${result.status}`);
}

let exitCode = 0;
try {
    await main();
} catch (error) {
    // Validation messages are safe to show; anything else is reported by type only.
    const message = error instanceof UserProvisioningError || error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? error.message
        : `Failed (${error?.name ?? "Error"})`;
    console.error(`User not provisioned: ${message}`);
    exitCode = 1;
} finally {
    const { default: prisma } = await import("../src/config/prisma.js").catch(() => ({ default: null }));
    await prisma?.$disconnect().catch(() => {});
}
process.exitCode = exitCode;
