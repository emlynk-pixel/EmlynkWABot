// Startup check of the runtime (checked before the environment, src/app.js).
//
// The Prisma client is generated into generated/prisma (git-ignored) as
// TypeScript files that Node loads directly. That needs:
//   - a Node version that strips TypeScript types by default:
//     22.18 or later in the 22 line, 23.6 or later, or 24+;
//   - the generated client itself: `npm install` runs `prisma generate`
//     (postinstall); otherwise run `npx prisma generate`.
// Without this check a fresh clone fails with ERR_MODULE_NOT_FOUND or a
// syntax error from inside the generated client.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const GENERATED_CLIENT_PATH = fileURLToPath(new URL("../../generated/prisma/client.ts", import.meta.url));
export const SUPPORTED_NODE_VERSIONS = "^22.18.0 || >=23.6.0";

// "22.18.0" / "v22.18.0" -> can Node run the generated .ts client as is?
export function nodeSupportsTypeStripping(version) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
    if (!match) return false;
    const [major, minor] = [Number(match[1]), Number(match[2])];
    if (major === 22) return minor >= 18;
    if (major === 23) return minor >= 6;
    return major >= 24;
}

// Returns the problems found; empty when the runtime is fine.
export function findRuntimeProblems({
    nodeVersion = process.versions.node,
    clientExists = fs.existsSync(GENERATED_CLIENT_PATH),
} = {}) {
    const problems = [];
    if (!nodeSupportsTypeStripping(nodeVersion)) {
        problems.push(`Node.js ${nodeVersion} is not supported; use ${SUPPORTED_NODE_VERSIONS}`);
    }
    if (!clientExists) {
        problems.push("The Prisma client is not generated (generated/prisma). Run: npx prisma generate");
    }
    return problems;
}

export function assertValidRuntime(options) {
    const problems = findRuntimeProblems(options);
    if (problems.length > 0) {
        throw new Error(`Invalid runtime:\n- ${problems.join("\n- ")}`);
    }
}
