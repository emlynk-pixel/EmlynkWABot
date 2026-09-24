import { readFileSync } from "node:fs";

// Fixture texts are synthetic. Never commit text from real client documents.
export function loadDocumentText(name) {
    return readFileSync(new URL(`../fixtures/documents/${name}.txt`, import.meta.url), "utf8");
}
