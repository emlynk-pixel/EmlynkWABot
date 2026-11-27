// The backend's Additional details completion (src/services/additionalDetailsCompletion.js, read from the
// Prisma row) agrees with the admin frontend's (admin/src/components/candidate/additionalDetailsCompletion.ts,
// read from the API's serialized copy of the same row), on a real PostgreSQL (PGlite) through the real
// Prisma client and getAdditionalDetails.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { completeAdditionalDetailsData } from "./helpers/completeAdditionalDetails.js";
import { ADDITIONAL_DETAILS_COMPLETION_SELECT, additionalDetailsComplete } from "../src/services/additionalDetailsCompletion.js";
import { ADDITIONAL_DETAILS_FIELDS, getAdditionalDetails } from "../src/services/candidateAdditionalDetailsService.js";
import { additionalDetailsComplete as frontendComplete } from "../admin/src/components/candidate/additionalDetailsCompletion.ts";

const P = "P0000001";
let database;
let prisma;

before(async () => { database = await createTestDatabase(); ({ prisma } = database); });
after(async () => database?.close());
beforeEach(async () => {
    await prisma.candidateAdditionalDetails.deleteMany();
    await prisma.candidate.deleteMany();
    await prisma.candidate.create({ data: { passportId: P, uniqueId: "7001", firstName: "Nimal", otherName: "Perera" } });
});

// Store `data`, then evaluate both rules on what each one reads.
async function both(data) {
    await prisma.candidateAdditionalDetails.deleteMany();
    if (data) await prisma.candidateAdditionalDetails.create({ data: { passportId: P, ...data } });
    const row = await prisma.candidateAdditionalDetails.findUnique({ where: { passportId: P }, select: ADDITIONAL_DETAILS_COMPLETION_SELECT });
    const api = (await getAdditionalDetails({ db: prisma, passportId: P })).details;
    return { backend: additionalDetailsComplete(row), frontend: frontendComplete(api) };
}

describe("Additional details completion: backend port = frontend rule", () => {
    test("no row, and a complete row (Date and Decimal values), agree", async () => {
        assert.deepEqual(await both(null), { backend: false, frontend: false });
        assert.deepEqual(await both(completeAdditionalDetailsData()), { backend: true, frontend: true });
    });

    test("every field left empty in turn: the two agree, and only the child names are optional", async () => {
        const optional = [];
        for (const field of ADDITIONAL_DETAILS_FIELDS) {
            const result = await both(completeAdditionalDetailsData({ [field]: null }));
            assert.equal(result.backend, result.frontend, field);
            if (result.backend) optional.push(field);
        }
        assert.deepEqual(optional, ["child1Name", "child2Name", "child3Name"]);
    });

    test("blank text is empty, false is an answer, and the conditional sections follow their answer", async () => {
        const cases = [
            [{ city: "   " }, false],
            [{ drivingLicence: false, canReadDrawings: false, teamLeadingSkills: false }, true],
            [{ fatherAlive: false, fatherFullName: null, fatherBirthday: null, fatherPassportNumber: null }, true],
            [{ fatherAlive: true, fatherPassportNumber: null }, false],
            [{ motherAlive: false, motherFullName: null, motherBirthday: null, motherPassportNumber: null }, true],
            [{ maritalStatus: "SINGLE", wifeFullName: null, wifeBirthday: null, spousePassportNumber: null }, true],
            [{ maritalStatus: "MARRIED", wifeBirthday: null }, false],
        ];
        for (const [extra, expected] of cases) {
            assert.deepEqual(await both(completeAdditionalDetailsData(extra)), { backend: expected, frontend: expected }, JSON.stringify(extra));
        }
    });

    test("the select reads only real Additional details columns", () => {
        for (const field of Object.keys(ADDITIONAL_DETAILS_COMPLETION_SELECT)) assert.ok(ADDITIONAL_DETAILS_FIELDS.includes(field), field);
        assert.equal(additionalDetailsComplete(undefined), false);
    });
});
