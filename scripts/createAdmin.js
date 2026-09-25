// Create an admin account (SEC-023).
//
//   npm run admin:create -- --name "Full Name" --email admin@example.com [--role ADMIN]
//
// The password is typed at a hidden prompt (asked twice). For automation it
// can come from the ADMIN_PASSWORD environment variable instead; never pass
// it as a command-line argument, where it would be saved in shell history.
//
// The account is created ACTIVE with a bcrypt hash. An existing email is
// refused: this script never changes or replaces an admin. Only the new
// admin's ID is printed; the password and its hash never are.

import "dotenv/config";
import readline from "node:readline";
import { parseArgs } from "node:util";

import { createAdminAccount, AdminProvisioningError } from "../src/services/adminProvisioningService.js";

// Reads a line without echoing it.
function promptHidden(question) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY) {
            reject(new Error("No terminal for the password prompt; set ADMIN_PASSWORD instead"));
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
    if (process.env.ADMIN_PASSWORD) {
        return process.env.ADMIN_PASSWORD;
    }
    const password = await promptHidden("Password: ");
    const repeated = await promptHidden("Repeat password: ");
    if (password !== repeated) {
        throw new AdminProvisioningError("PASSWORD_MISMATCH", "Passwords do not match");
    }
    return password;
}

async function main() {
    const { values } = parseArgs({
        options: {
            name: { type: "string" },
            email: { type: "string" },
            role: { type: "string", default: "ADMIN" },
        },
        strict: true,
    });

    const password = await readPassword();
    const result = await createAdminAccount({ name: values.name, email: values.email, password, role: values.role });
    console.log(`Admin created: adminId=${result.adminId}, status=${result.status}`);
}

let exitCode = 0;
try {
    await main();
} catch (error) {
    // Validation messages are safe to show; anything else is reported by type only.
    const message = error instanceof AdminProvisioningError || error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? error.message
        : `Failed (${error?.name ?? "Error"})`;
    console.error(`Admin not created: ${message}`);
    exitCode = 1;
} finally {
    const { default: prisma } = await import("../src/config/prisma.js").catch(() => ({ default: null }));
    await prisma?.$disconnect().catch(() => {});
}
process.exit(exitCode);
