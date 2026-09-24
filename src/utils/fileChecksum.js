import { createHash } from "node:crypto";

// Lowercase hex SHA-256 of a file's bytes: always 64 characters.
// Used to spot the exact same file being sent again (proposal §31).
export function sha256Hex(buffer) {
    if (!Buffer.isBuffer(buffer)) {
        throw new TypeError("sha256Hex expects a Buffer");
    }

    return createHash("sha256").update(buffer).digest("hex");
}

export function isSha256Hex(value) {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
