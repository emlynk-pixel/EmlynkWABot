import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    copyToFreeName,
    removeObject,
    StorageCopyError,
    MAX_NAME_ATTEMPTS,
} from "../src/services/permanentStorageService.js";
import { standardFileName, withNumericSuffix } from "../src/utils/storageNaming.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";

const TEMP = "temporary/0b7c.pdf";
const FOLDER = "clients/N1234567/passport";
const passportName = (attempt) => standardFileName("PASSPORT", attempt, ".pdf");

describe("copyToFreeName", () => {
    test("copies to the first name and keeps the temporary object", async () => {
        const bucket = createFakeBucket([TEMP]);
        const result = await copyToFreeName({ fromPath: TEMP, folder: FOLDER, nameForAttempt: passportName }, { bucket });

        assert.deepEqual(result, { storagePath: `${FOLDER}/passport.pdf`, fileName: "passport.pdf", attempt: 1 });
        assert.ok(bucket.has(TEMP), "temporary object must remain (Phase 8 cleans it up)");
        assert.ok(bucket.has(`${FOLDER}/passport.pdf`));
    });

    test("an existing name is never overwritten: the next free name is used", async () => {
        const bucket = createFakeBucket([TEMP, `${FOLDER}/passport.pdf`, `${FOLDER}/passport_v2.pdf`]);
        const result = await copyToFreeName({ fromPath: TEMP, folder: FOLDER, nameForAttempt: passportName }, { bucket });

        assert.equal(result.fileName, "passport_v3.pdf");
        assert.ok(!bucket.calls.some((c) => c.method === "copy" && c.toPath.endsWith("/passport.pdf")));
    });

    test("can start at a given version", async () => {
        const bucket = createFakeBucket([TEMP]);
        const result = await copyToFreeName({ fromPath: TEMP, folder: FOLDER, nameForAttempt: passportName, firstAttempt: 2 }, { bucket });

        assert.equal(result.fileName, "passport_v2.pdf");
    });

    test("a name taken between the check and the copy (race) moves on to the next name", async () => {
        const bucket = createFakeBucket([TEMP], { takenOnCopy: [`${FOLDER}/passport.pdf`] });
        const result = await copyToFreeName({ fromPath: TEMP, folder: FOLDER, nameForAttempt: passportName }, { bucket });

        assert.equal(result.fileName, "passport_v2.pdf");
    });

    test("works with numeric suffixes for kept original names", async () => {
        const pending = "pending/0001/undefined/uncleared-docs";
        const bucket = createFakeBucket([TEMP, `${pending}/scan.pdf`]);
        const result = await copyToFreeName(
            { fromPath: TEMP, folder: pending, nameForAttempt: (n) => withNumericSuffix("scan.pdf", n) },
            { bucket }
        );

        assert.equal(result.fileName, "scan_2.pdf");
    });

    test("storage failure throws StorageCopyError and copies nothing", async () => {
        const bucket = createFakeBucket([TEMP], { failCopy: true });

        await assert.rejects(
            copyToFreeName({ fromPath: TEMP, folder: FOLDER, nameForAttempt: passportName }, { bucket }),
            StorageCopyError
        );
        assert.deepEqual([...bucket.objects.keys()], [TEMP]);
    });

    test("missing temporary object throws instead of looping", async () => {
        const bucket = createFakeBucket([]);
        await assert.rejects(
            copyToFreeName({ fromPath: TEMP, folder: FOLDER, nameForAttempt: passportName }, { bucket }),
            StorageCopyError
        );
    });

    test(`gives up after ${MAX_NAME_ATTEMPTS} taken names`, async () => {
        const taken = Array.from({ length: MAX_NAME_ATTEMPTS }, (_, i) => `${FOLDER}/${passportName(i + 1)}`);
        const bucket = createFakeBucket([TEMP, ...taken]);

        await assert.rejects(
            copyToFreeName({ fromPath: TEMP, folder: FOLDER, nameForAttempt: passportName }, { bucket }),
            /No free file name/
        );
    });
});

describe("removeObject", () => {
    test("removes one object and reports success", async () => {
        const bucket = createFakeBucket([`${FOLDER}/passport.pdf`, TEMP]);
        const result = await removeObject(`${FOLDER}/passport.pdf`, { bucket });

        assert.deepEqual(result, { removed: true, error: null });
        assert.ok(!bucket.has(`${FOLDER}/passport.pdf`));
        assert.ok(bucket.has(TEMP));
    });

    test("a failed removal is reported, not thrown", async () => {
        const bucket = createFakeBucket([`${FOLDER}/passport.pdf`], { failRemove: true });
        const result = await removeObject(`${FOLDER}/passport.pdf`, { bucket });

        assert.equal(result.removed, false);
        assert.match(result.error, /Remove failed/);
    });
});
