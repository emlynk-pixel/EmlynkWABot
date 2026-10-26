// Candidate Form: the Personal Details answers (City in Romania + approximate distance to
// Bucharest, Blood Group, Other Languages, Driving Licence, Can Read Drawings, Team Leading
// Skills, Height, Weight) and the parents' Mother / Father Alive answers (PERSONAL-NEW-*,
// HEIGHT-*, WEIGHT-*, FAMILY-NEW-*, DISTANCE-*), plus the additive migration on historical rows
// (MIGRATION-*). Pure parseSubmission checks, then the real public and admin routers on a REAL
// PostgreSQL (PGlite, every migration). Synthetic data.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { createTestDatabase, migrationNames } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { BLOOD_GROUPS, parseSubmission } from "../src/services/candidateFormDataService.js";
import { formatWeightKg, parseHeight, parseWeight } from "../src/utils/bodyMeasurements.js";
import { BUCHAREST, distanceToBucharestKm, findRomanianCity, haversineKm, ROMANIA_CITIES } from "../src/utils/romaniaCities.js";

const NOW = new Date("2026-10-20T06:00:00.000Z");
const KEY = "key-personal-000001";
const MIGRATION = "20261101120000_candidate_form_personal_details";

const ANSWERS = () => ({
    basic: {
        fullName: "anusha de soysa", surname: "de soysa", otherNames: "n/a", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "negombo",
        bloodGroup: "O+", height: "175 cm", weight: "70", drivingLicence: "YES", canReadDrawings: "NO", teamLeadingSkills: "YES", otherLanguages: "english, romanian, arabic",
    },
    contact: { address: "12 galle road", city: "negombo", district: "gampaha", dsDivision: "negombo", gnDivision: "kurana", alternativePhone: "N/a", email: "a@example.com", cityInRomania: "Cluj-Napoca" },
    passport: { issueDate: "2020-01-15", expiryDate: "2030-01-14" },
    qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "5 years", otherSkills1: "N/A", otherSkills2: "n/A", englishKnowledge: "GOOD" },
    measurements: { shirtSize: "M", waistSize: "32", shoeSize: "9" },
    family: {
        father: { name: "sunil", surname: "de soysa", passportNumber: "N/A", birthDate: "1960-03-02" },
        mother: { name: "kumari", surname: "de soysa", passportNumber: "N/A", birthDate: "1965-02-03" },
        spouse: { name: "", surname: "", passportNumber: "", birthDate: "" }, child1: "n/a", child2: "", child3: "", fatherAlive: "NO", motherAlive: "YES",
    },
    guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "1960-01-01", phone: "+94 77 123 4567", address: "45 lake road" },
});
const set = (answers, at, value) => {
    const parts = at.split(".");
    let target = answers;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts.at(-1)] = value;
    return answers;
};
const parse = (answers) => parseSubmission({ answers, idempotencyKey: KEY }, { now: NOW });
const valuesWith = (at, value) => parse(set(ANSWERS(), at, value)).values;
const errorsWith = (at, value) => (parse(set(ANSWERS(), at, value)).errors ?? []).map((e) => `${e.field}:${e.code}`);

describe("server: Personal Details answers (parseSubmission)", () => {
    test("PERSONAL-NEW-001 City in Romania: trimmed, diacritics kept, a listed city in its official spelling", () => {
        assert.equal(parse(ANSWERS()).errors, undefined);
        assert.equal(valuesWith("contact.cityInRomania", "  cluj   napoca ").cityInRomania, "Cluj-Napoca");
        assert.equal(valuesWith("contact.cityInRomania", "Brasov").cityInRomania, "Brașov", "found without diacritics");
        assert.equal(valuesWith("contact.cityInRomania", "Constanţa").cityInRomania, "Constanța", "cedilla ţ and comma ț are the same letter");
        assert.equal(valuesWith("contact.cityInRomania", "simleu silvaniei").cityInRomania, "Șimleu Silvaniei", "a listed town (every town is) is stored in its official spelling");
        assert.equal(valuesWith("contact.cityInRomania", "Șoimuș").cityInRomania, "Șoimuș", "a place that is not a city is kept as typed, diacritics included");
        assert.equal(valuesWith("contact.cityInRomania", "n/a").cityInRomania, "N/A", "not in Romania");
        assert.deepEqual(errorsWith("contact.cityInRomania", ""), ["contact.cityInRomania:required"]);
        assert.deepEqual(errorsWith("contact.cityInRomania", "12345"), ["contact.cityInRomania:invalid"]);
        assert.deepEqual(errorsWith("contact.cityInRomania", "<script>"), ["contact.cityInRomania:invalid"]);
        assert.deepEqual(errorsWith("contact.cityInRomania", "a".repeat(101)), ["contact.cityInRomania:tooLong"]);
    });

    test("PERSONAL-NEW-002 Blood Group accepts only the eight groups (no free text, no N/A)", () => {
        for (const group of BLOOD_GROUPS) assert.equal(valuesWith("basic.bloodGroup", group).bloodGroup, group);
        for (const bad of ["a+", "O", "AB", "0+", "A +", "unknown", "N/A"]) assert.deepEqual(errorsWith("basic.bloodGroup", bad), ["basic.bloodGroup:invalid"], bad);
        assert.deepEqual(errorsWith("basic.bloodGroup", ""), ["basic.bloodGroup:required"]);
    });

    test("PERSONAL-NEW-003 Other Languages: trimmed text, at most 150 characters, N/A for none", () => {
        assert.equal(valuesWith("basic.otherLanguages", "  english, romanian, arabic  ").otherLanguages, "ENGLISH, ROMANIAN, ARABIC");
        assert.equal(valuesWith("basic.otherLanguages", "na").otherLanguages, "N/A");
        assert.deepEqual(errorsWith("basic.otherLanguages", "x".repeat(151)), ["basic.otherLanguages:tooLong"]);
        assert.deepEqual(errorsWith("basic.otherLanguages", "   "), ["basic.otherLanguages:required"]);
    });

    for (const [id, key, column] of [["PERSONAL-NEW-004", "drivingLicence", "drivingLicence"], ["PERSONAL-NEW-005", "canReadDrawings", "canReadDrawings"], ["PERSONAL-NEW-006", "teamLeadingSkills", "teamLeadingSkills"]]) {
        test(`${id} ${key}: YES / NO, stored as true / false; anything else (and N/A) refused; required`, () => {
            assert.equal(valuesWith(`basic.${key}`, "YES")[column], true);
            assert.equal(valuesWith(`basic.${key}`, "NO")[column], false);
            for (const bad of ["yes", "Y", "true", "1", "N/A", "MAYBE"]) assert.deepEqual(errorsWith(`basic.${key}`, bad), [`basic.${key}:invalid`], bad);
            assert.deepEqual(errorsWith(`basic.${key}`, ""), [`basic.${key}:required`]);
        });
    }
});

describe("server: Height", () => {
    test("HEIGHT-001 centimetres (a number alone is cm)", () => {
        assert.deepEqual(parseHeight("175 cm"), { text: "175 cm", cm: 175 });
        assert.deepEqual(parseHeight("175"), { text: "175 cm", cm: 175 });
        assert.deepEqual(parseHeight("175CM"), { text: "175 cm", cm: 175 });
        const v = valuesWith("basic.height", " 175  cm ");
        assert.deepEqual([v.height, v.heightCm], ["175 cm", 175]);
    });

    test("HEIGHT-002 metres", () => {
        assert.deepEqual(parseHeight("1.75 m"), { text: "1.75 m", cm: 175 });
        assert.deepEqual(parseHeight("1,75m"), { text: "1.75 m", cm: 175 });
        const v = valuesWith("basic.height", "1.75 m");
        assert.deepEqual([v.height, v.heightCm], ["1.75 m", 175]);
    });

    test("HEIGHT-003 feet and inches, normalised to cm (5'9\" = 69 in = 175.26 cm, kept to one decimal)", () => {
        for (const typed of [`5'9"`, "5' 9\"", "5 ft 9 in", "5ft9in", "5 feet 9 inches", "5'9", "5’9”"]) assert.deepEqual(parseHeight(typed), { text: `5'9"`, cm: 175.3 }, typed);
        assert.deepEqual(parseHeight("6 ft"), { text: `6'0"`, cm: 182.9 });
        const v = valuesWith("basic.height", "5 ft 9 in");
        assert.deepEqual([v.height, v.heightCm], [`5'9"`, 175.3], "the candidate's own unit is kept for display");
    });

    test("HEIGHT-004 decimals in every unit", () => {
        assert.deepEqual(parseHeight("175.5 cm"), { text: "175.5 cm", cm: 175.5 });
        assert.deepEqual(parseHeight("1.755 m"), { text: "1.755 m", cm: 175.5 });
        assert.deepEqual(parseHeight("5'9.5\""), { text: `5'9.5"`, cm: 176.5 });
    });

    test("HEIGHT-005 invalid heights are refused", () => {
        for (const bad of ["abc", "-175", "0 cm", "9999 cm", "1.75", "49 cm", "251 cm", "5'12\"", "175 kg", "tall", "175 cm 5", "1.75 m m"]) {
            assert.equal(parseHeight(bad), null, bad);
            assert.deepEqual(errorsWith("basic.height", bad), ["basic.height:invalid"], bad);
        }
        assert.deepEqual(errorsWith("basic.height", "N/A"), ["basic.height:invalid"], "N/A is not a height");
    });

    test("HEIGHT-006 Height is required", () => {
        for (const blank of ["", "   ", null, undefined]) assert.deepEqual(errorsWith("basic.height", blank), ["basic.height:required"], String(blank));
    });
});

describe("server: Weight", () => {
    test("WEIGHT-001 a number alone is kg: 70 -> 70 kg", () => {
        assert.equal(parseWeight("70"), 70);
        assert.equal(valuesWith("basic.weight", "70").weightKg, 70);
        assert.equal(formatWeightKg(70), "70 kg");
    });

    test("WEIGHT-002 decimals: 70.5 (and 70,5)", () => {
        assert.equal(parseWeight("70.5"), 70.5);
        assert.equal(parseWeight("70,5"), 70.5);
        assert.equal(formatWeightKg(70.5), "70.5 kg");
    });

    test("WEIGHT-003 kg", () => {
        for (const typed of ["70 kg", "70kg", "70 KG", "70 kgs"]) assert.equal(parseWeight(typed), 70, typed);
    });

    test("WEIGHT-004 grams are normalised to kg (no duplicate unit is ever stored)", () => {
        assert.equal(parseWeight("70000 g"), 70);
        assert.equal(parseWeight("70500g"), 70.5);
        assert.equal(valuesWith("basic.weight", "70000 g").weightKg, 70);
        assert.equal(formatWeightKg(parseWeight("70 kg")), "70 kg", "never 70 kg kg");
    });

    test("WEIGHT-005 invalid, zero and negative weights are refused", () => {
        for (const bad of ["abc", "-70", "0", "0 kg", "70 bananas", "70 kg kg", "19 kg", "301", "70 lb", "N/A"]) {
            assert.deepEqual(errorsWith("basic.weight", bad), ["basic.weight:invalid"], bad);
        }
    });

    test("WEIGHT-006 Weight is required", () => {
        for (const blank of ["", "  ", null]) assert.deepEqual(errorsWith("basic.weight", blank), ["basic.weight:required"]);
    });
});

describe("server: Mother / Father Alive", () => {
    test("FAMILY-NEW-001 Mother Alive is required (no N/A), even when the mother's name is N/A", () => {
        assert.deepEqual(errorsWith("family.motherAlive", ""), ["family.motherAlive:required"]);
        assert.deepEqual(errorsWith("family.motherAlive", "N/A"), ["family.motherAlive:invalid"]);
        const unknown = set(set(ANSWERS(), "family.mother.name", "N/A"), "family.motherAlive", "");
        for (const k of ["surname", "passportNumber", "birthDate"]) unknown.family.mother[k] = "";
        assert.deepEqual(parse(unknown).errors.map((e) => `${e.field}:${e.code}`), ["family.motherAlive:required"]);
    });

    test("FAMILY-NEW-002 Father Alive is required", () => {
        assert.deepEqual(errorsWith("family.fatherAlive", ""), ["family.fatherAlive:required"]);
        assert.deepEqual(errorsWith("family.fatherAlive", "dead"), ["family.fatherAlive:invalid"]);
    });

    test("FAMILY-NEW-003 the existing parent fields are unchanged; alive answers are booleans", () => {
        const v = parse(ANSWERS()).values;
        assert.deepEqual([v.fatherAlive, v.motherAlive], [false, true]);
        assert.deepEqual([v.fatherName, v.motherName, v.fatherBirthDate.toISOString().slice(0, 10)], ["SUNIL", "KUMARI", "1960-03-02"]);
    });
});

describe("server: Distance to Bucharest", () => {
    test("DISTANCE-001 a listed city gives its approximate straight-line distance (Haversine, whole km)", () => {
        const cluj = findRomanianCity("Cluj-Napoca");
        // Computed independently: the great-circle distance between the two centres.
        const expected = Math.round(haversineKm({ lat: 46.7689, lon: 23.5907 }, { lat: BUCHAREST.lat, lon: BUCHAREST.lon }));
        assert.equal(cluj.distanceKm, expected);
        assert.ok(cluj.distanceKm > 300 && cluj.distanceKm < 340, `${cluj.distanceKm} km`);
        assert.equal(valuesWith("contact.cityInRomania", "cluj-napoca").distanceToBucharestKm, expected);
        assert.equal(findRomanianCity("Bucharest").distanceKm, 0);
        assert.equal(distanceToBucharestKm(BUCHAREST), 0);
        // A known pair, checked against the formula itself: one degree of latitude is ~111.2 km.
        assert.equal(Math.round(haversineKm({ lat: 44, lon: 26 }, { lat: 45, lon: 26 })), 111);
    });

    test("DISTANCE-002 every distance is a whole, non-negative number of km; every listed city is unique", () => {
        for (const city of ROMANIA_CITIES) assert.ok(Number.isInteger(city.distanceKm) && city.distanceKm >= 0 && city.distanceKm < 700, city.name);
        assert.equal(new Set(ROMANIA_CITIES.map((city) => city.name)).size, ROMANIA_CITIES.length);
    });

    test("DISTANCE-003 the distance is derived by the server: a submitted distance is refused, never stored", () => {
        const spoofed = ANSWERS();
        spoofed.contact.distanceToBucharestKm = "1";
        assert.deepEqual(parse(spoofed).errors.map((e) => `${e.field}:${e.code}`), ["contact.distanceToBucharestKm:unknown"]);
        const alsoSpoofed = ANSWERS();
        alsoSpoofed.basic.heightCm = "250";
        assert.deepEqual(parse(alsoSpoofed).errors.map((e) => `${e.field}:${e.code}`), ["basic.heightCm:unknown"]);
    });

    test("DISTANCE-004 an unlisted city, or N/A, is kept with no distance (null), never a guess", () => {
        assert.deepEqual([valuesWith("contact.cityInRomania", "Satu Nou").cityInRomania, valuesWith("contact.cityInRomania", "Satu Nou").distanceToBucharestKm], ["Satu Nou", null]);
        assert.equal(valuesWith("contact.cityInRomania", "N/A").distanceToBucharestKm, null);
        assert.equal(findRomanianCity("Atlantis"), null);
        assert.equal(findRomanianCity(undefined), null);
    });
});

// ---------------------------------------------------------------- routes (real PostgreSQL)

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const ADMIN = { adminId: "u-admin", role: "ADMIN", name: "ADMIN 1", email: "u-admin@example.invalid", authUserId: "00000000-0000-4000-8000-000000000001" };
const A = { passportId: "N7100001", uniqueId: "7101", firstName: "Anusha", otherName: "De Soysa", nic: "710000001V", sex: "F", whatsappNumber: "+94751000001" };

describe("routes: the new answers are stored, read back and reviewed", () => {
    let database;
    let prisma;
    let pg;
    before(async () => {
        database = await createTestDatabase();
        ({ prisma, pg } = database);
        await prisma.user.create({ data: ADMIN });
    });
    after(async () => database?.close());
    beforeEach(async () => {
        await pg.exec(`
            ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
            DELETE FROM "rate_limits"; DELETE FROM "candidate_form_field_review"; DELETE FROM "candidate_form_sheet_sync"; DELETE FROM "candidate_form_draft";
            DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_prefill_snapshot"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";
            DELETE FROM "candidate_additional_details"; DELETE FROM "candidate";
        `);
        await prisma.candidate.create({ data: A });
    });

    const app = () => {
        const server = express();
        server.use(PUBLIC_CANDIDATE_DETAILS_PATH, createPublicCandidateDetailsRouter({ db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, verifyIpLimiter: noRateLimit, verifyPassportLimiter: noRateLimit, log: { warn() {}, error() {}, info() {}, log() {} } }));
        server.use(express.json());
        const requireAdmin = async (req, res, next) => {
            req.user = await prisma.user.findUnique({ where: { adminId: ADMIN.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
            next();
        };
        server.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit, candidateFormOrigin: ORIGIN }));
        server.use(errorHandler);
        return server;
    };
    async function call(method, at, { body, token } = {}) {
        const listener = await new Promise((resolve) => { const s = app().listen(0, "127.0.0.1", () => resolve(s)); });
        try {
            const headers = { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
            const res = await fetch(`http://127.0.0.1:${listener.address().port}${at}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
            return { status: res.status, body: await res.json().catch(() => null) };
        } finally {
            listener.close();
        }
    }
    const pub = (at, options) => call("POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${at}`, options);
    async function session() {
        const link = (await call("POST", `/api/admin/candidates/${A.passportId}/form-share`)).body.url.split("#k=")[1];
        return (await pub("/verify", { body: { linkSecret: link, passportNumber: A.passportId, nic: A.nic } })).body.token;
    }

    test("PERSONAL-NEW-001 / FAMILY-NEW-003 / DISTANCE-002 a submission stores every new answer; the distance in km; the height in cm", async () => {
        const token = await session();
        const form = await pub("/form", { token, body: {} });
        assert.equal(form.status, 200);
        assert.ok(form.body.romanianCities.some((city) => city.name === "Cluj-Napoca" && city.distanceKm === findRomanianCity("Cluj-Napoca").distanceKm));
        const answers = set(set(ANSWERS(), "basic.height", "5 ft 9 in"), "basic.weight", "70500 g");
        const r = await pub("/submit", { token, body: { answers, idempotencyKey: KEY } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const row = await prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } });
        assert.deepEqual(
            [row.cityInRomania, row.distanceToBucharestKm, row.bloodGroup, row.otherLanguages, row.drivingLicence, row.canReadDrawings, row.teamLeadingSkills, row.height, Number(row.heightCm), Number(row.weightKg), row.fatherAlive, row.motherAlive],
            ["Cluj-Napoca", findRomanianCity("Cluj-Napoca").distanceKm, "O+", "ENGLISH, ROMANIAN, ARABIC", true, false, true, `5'9"`, 175.3, 70.5, false, true],
        );
    });

    test("DISTANCE-003 (route) a distance sent with the answers is refused and nothing is stored", async () => {
        const token = await session();
        const answers = ANSWERS();
        answers.contact.distanceToBucharestKm = "5";
        const r = await pub("/submit", { token, body: { answers, idempotencyKey: KEY } });
        assert.equal(r.status, 400);
        assert.ok(r.body.errors.some((e) => e.field === "contact.distanceToBucharestKm"));
        assert.equal(await prisma.candidateFormResponse.count(), 0);
    });

    test("HEIGHT-005 / WEIGHT-005 (route) an invalid height or weight is refused field by field", async () => {
        const token = await session();
        const r = await pub("/submit", { token, body: { answers: set(set(ANSWERS(), "basic.height", "9999 cm"), "basic.weight", "70 bananas"), idempotencyKey: KEY } });
        assert.equal(r.status, 400);
        assert.deepEqual(r.body.errors.map((e) => e.field).sort(), ["basic.height", "basic.weight"]);
    });

    test("the saved progress (Next) keeps the new answers as the form shows them, and restores them", async () => {
        const token = await session();
        const saved = await pub("/draft", { token, body: { step: "personal", answers: { basic: set(ANSWERS(), "basic.weight", "70000 g").basic, contact: ANSWERS().contact } } });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        const form = await pub("/form", { token, body: {} });
        assert.deepEqual(
            [form.body.answers.basic.height, form.body.answers.basic.weight, form.body.answers.basic.drivingLicence, form.body.answers.contact.cityInRomania],
            ["175 cm", "70", "YES", "Cluj-Napoca"],
        );
    });

    test("prefill: the parents' alive answers come from Additional Details; the other new answers start empty", async () => {
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, fatherAlive: false, motherAlive: true } });
        const token = await session();
        const form = await pub("/form", { token, body: {} });
        assert.deepEqual([form.body.answers.family.fatherAlive, form.body.answers.family.motherAlive], ["NO", "YES"]);
        assert.ok(form.body.prefilled.includes("family.fatherAlive") && !form.body.prefilled.includes("basic.height"));
        assert.equal(form.body.answers.basic.bloodGroup, null);
    });

    test("Admin readback: every new answer (and the derived cm / km) is shown; Mother / Father Alive are confirmable into Additional Details", async () => {
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, fatherAlive: true, motherAlive: true } });
        const token = await session();
        await pub("/form", { token, body: {} });
        assert.equal((await pub("/submit", { token, body: { answers: ANSWERS(), idempotencyKey: KEY } })).status, 200);
        const view = await call("GET", `/api/admin/candidates/${A.passportId}/form-submission`);
        assert.equal(view.status, 200);
        const s = view.body.submitted;
        assert.deepEqual(
            [s["contact.cityInRomania"], s["contact.distanceToBucharestKm"], s["basic.bloodGroup"], s["basic.height"], s["basic.heightCm"], s["basic.weight"], s["basic.drivingLicence"], s["basic.canReadDrawings"], s["basic.teamLeadingSkills"], s["basic.otherLanguages"], s["family.fatherAlive"], s["family.motherAlive"]],
            ["Cluj-Napoca", String(findRomanianCity("Cluj-Napoca").distanceKm), "O+", "175 cm", "175", "70", "YES", "NO", "YES", "ENGLISH, ROMANIAN, ARABIC", "NO", "YES"],
        );
        assert.ok(view.body.changed.includes("family.fatherAlive"), "YES on record -> NO submitted");
        assert.ok(!view.body.changed.includes("basic.heightCm") && !view.body.changed.includes("contact.distanceToBucharestKm"), "derived values are not compared");
        // Of the alive answers only the father differs from the record: pending; the mother already matches.
        assert.deepEqual(view.body.pending.filter((change) => change.field.endsWith("Alive")), [{ field: "family.fatherAlive", current: "YES", submitted: "NO" }]);

        const confirmed = await call("POST", `/api/admin/candidates/${A.passportId}/form-submission/confirm-field`, { body: { field: "family.fatherAlive", expectedCurrentValue: "YES", expectedSubmittedValue: "NO" } });
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
        const details = await prisma.candidateAdditionalDetails.findUnique({ where: { passportId: A.passportId } });
        assert.deepEqual([details.fatherAlive, details.motherAlive], [false, true], "only the confirmed column changed");
        // The other new answers have no home in the record: never confirmable.
        for (const field of ["basic.bloodGroup", "basic.height", "contact.cityInRomania"]) {
            const r = await call("POST", `/api/admin/candidates/${A.passportId}/form-submission/confirm-field`, { body: { field, expectedCurrentValue: null, expectedSubmittedValue: "x" } });
            assert.equal(r.status, 400, field);
        }
    });
});

// ---------------------------------------------------------------- migration rehearsal

describe("migration 20261101120000_candidate_form_personal_details on existing data", () => {
    test("MIGRATION-001 it is the newest migration, additive only (no DROP, RENAME, ALTER TYPE, UPDATE or DELETE)", () => {
        assert.equal(migrationNames().at(-1), MIGRATION);
        const sql = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations", MIGRATION, "migration.sql"), "utf8")
            .split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
        assert.doesNotMatch(sql, /\b(DROP|RENAME|TYPE|UPDATE|DELETE|TRUNCATE|SET NOT NULL)\b/i);
        assert.doesNotMatch(sql, /NOT NULL/i, "every new column is nullable");
    });

    test("MIGRATION-002 historical candidates, submissions and snapshots survive unchanged and stay readable; a new submission persists", async () => {
        const previous = migrationNames().at(-2);
        const database = await createTestDatabase({ upTo: previous });
        try {
            const { pg } = database;
            // A database as it is before this migration: two candidates, one with a submitted form.
            await pg.exec(`
                INSERT INTO "candidate" ("passport_id", "unique_id", "nic", "first_name", "other_name", "updated_date") VALUES ('N7200001', '7201', '720000001V', 'Old', 'Candidate', now()), ('N7200002', '7202', '720000002V', 'No', 'Form', now());
                INSERT INTO "candidate_form_prefill_snapshot" ("passport_id", "full_name", "city") VALUES ('N7200001', 'OLD CANDIDATE', 'NEGOMBO');
                INSERT INTO "candidate_form_response" ("passport_id", "full_name", "city", "shoe_size", "guardian_name") VALUES ('N7200001', 'OLD CANDIDATE', 'NEGOMBO', '9', 'KAMAL');
            `);
            const before = (await pg.query(`SELECT * FROM "candidate_form_response"`)).rows;

            await pg.exec(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations", MIGRATION, "migration.sql"), "utf8"));

            const { prisma } = database;
            assert.equal(await prisma.candidate.count(), 2, "no candidate lost");
            const old = await prisma.candidateFormResponse.findUnique({ where: { passportId: "N7200001" } });
            for (const [column, value] of Object.entries(before[0])) {
                const camel = column.replace(/_(\w)/g, (_, c) => c.toUpperCase());
                if (camel in old && !(value instanceof Date)) assert.deepEqual(old[camel], value, column);
            }
            assert.deepEqual([old.fullName, old.city, old.shoeSize, old.guardianName], ["OLD CANDIDATE", "NEGOMBO", "9", "KAMAL"], "no submission value lost");
            assert.deepEqual([old.cityInRomania, old.distanceToBucharestKm, old.bloodGroup, old.height, old.heightCm, old.weightKg, old.fatherAlive, old.motherAlive], [null, null, null, null, null, null, null, null]);
            const snapshot = await prisma.candidateFormPrefillSnapshot.findUnique({ where: { passportId: "N7200001" } });
            assert.deepEqual([snapshot.fullName, snapshot.bloodGroup, snapshot.fatherAlive], ["OLD CANDIDATE", null, null]);

            // A new submission on the migrated database keeps every new value; the constraints hold.
            await prisma.candidateFormResponse.create({
                data: { passportId: "N7200002", fullName: "NO FORM", cityInRomania: "Iași", distanceToBucharestKm: findRomanianCity("Iasi").distanceKm, bloodGroup: "AB-", height: "1.8 m", heightCm: 180, weightKg: 82.25, drivingLicence: true, canReadDrawings: false, teamLeadingSkills: true, otherLanguages: "ENGLISH", fatherAlive: true, motherAlive: false },
            });
            const fresh = await prisma.candidateFormResponse.findUnique({ where: { passportId: "N7200002" } });
            assert.deepEqual([fresh.cityInRomania, fresh.bloodGroup, Number(fresh.heightCm), Number(fresh.weightKg), fresh.motherAlive], ["Iași", "AB-", 180, 82.25, false]);
            // (A stored submission can never be changed: candidate_form_response refuses updates.)
            await assert.rejects(pg.query(`UPDATE "candidate_form_response" SET "blood_group" = 'O+' WHERE "passport_id" = 'N7200002'`), /cannot be changed/);
            await pg.exec(`INSERT INTO "candidate" ("passport_id", "unique_id", "nic", "first_name", "other_name", "updated_date") VALUES ('N7200003', '7203', '720000003V', 'Third', 'Candidate', now())`);
            await assert.rejects(pg.query(`INSERT INTO "candidate_form_response" ("passport_id", "blood_group") VALUES ('N7200003', 'Z+')`), /blood_group_check/);
            await assert.rejects(pg.query(`INSERT INTO "candidate_form_response" ("passport_id", "weight_kg") VALUES ('N7200003', 0)`), /weight_kg_check/);
            await assert.rejects(pg.query(`INSERT INTO "candidate_form_response" ("passport_id", "height_cm") VALUES ('N7200003', 999)`), /height_cm_check|numeric field overflow/);
        } finally {
            await database.close();
        }
    });
});
