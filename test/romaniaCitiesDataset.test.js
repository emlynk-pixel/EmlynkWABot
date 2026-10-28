// The Romanian urban-locality dataset behind "Current City in Romania" / "Distance to Bucharest"
// (src/utils/romaniaCities.js, data in romaniaCitiesData.js). Pure checks: no database, no network.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { BUCHAREST, cityKey, distanceToBucharestKm, findRomanianCity, haversineKm, ROMANIA_CITIES } from "../src/utils/romaniaCities.js";
import { ROMANIA_URBAN_LOCALITIES } from "../src/utils/romaniaCitiesData.js";
import { parseSubmission } from "../src/services/candidateFormDataService.js";

// Romania has 103 municipalities (Bucharest included) and 216 towns: 319 urban localities.
const MUNICIPALITIES = 103;
const TOWNS = 216;

describe("dataset: completeness and shape", () => {
    test("CITY-DATA-001 exactly the 319 urban localities: 103 municipalities (Bucharest included) and 216 towns", () => {
        assert.equal(ROMANIA_CITIES.length, MUNICIPALITIES + TOWNS);
        assert.equal(ROMANIA_CITIES.filter((city) => city.kind === "M").length, MUNICIPALITIES);
        assert.equal(ROMANIA_CITIES.filter((city) => city.kind === "T").length, TOWNS);
        assert.equal(ROMANIA_URBAN_LOCALITIES.length, 319);
    });

    test("CITY-DATA-002 names, SIRUTA codes and folded search keys are all unique", () => {
        assert.equal(new Set(ROMANIA_CITIES.map((city) => city.name)).size, ROMANIA_CITIES.length);
        assert.equal(new Set(ROMANIA_CITIES.map((city) => city.siruta)).size, ROMANIA_CITIES.length);
        assert.equal(new Set(ROMANIA_CITIES.map((city) => cityKey(city.name))).size, ROMANIA_CITIES.length, "no two names fold to the same search key");
        // The one repeated name is told apart by its county.
        assert.deepEqual(ROMANIA_CITIES.filter((city) => city.name.startsWith("Ștefănești")).map((city) => city.name).sort(), ["Ștefănești (Argeș)", "Ștefănești (Botoșani)"]);
    });

    test("CITY-DATA-003 every locality has a SIRUTA code, a kind and valid coordinates inside Romania", () => {
        for (const city of ROMANIA_CITIES) {
            assert.ok(Number.isInteger(city.siruta) && city.siruta > 0, `${city.name}: SIRUTA`);
            assert.ok(city.kind === "M" || city.kind === "T", `${city.name}: kind`);
            assert.ok(Number.isFinite(city.lat) && Number.isFinite(city.lon), `${city.name}: numeric coordinates`);
            assert.ok(city.lat > 43.5 && city.lat < 48.3 && city.lon > 20.2 && city.lon < 29.8, `${city.name}: inside Romania (${city.lat}, ${city.lon})`);
        }
    });

    test("CITY-DATA-004 names are well formed and keep Romanian diacritics (comma-below ș ț, never cedilla ş ţ)", () => {
        for (const { name } of ROMANIA_CITIES) {
            assert.equal(name, name.normalize("NFC"), `${name}: NFC`);
            assert.equal(name, name.trim(), `${name}: trimmed`);
            assert.match(name, /^[\p{L}][\p{L} .'-]*(?: \([\p{L} -]+\))?$/u, `${name}: only letters, spaces, hyphens, dots`);
            assert.doesNotMatch(name, /[şţŞŢ]/, `${name}: cedilla`);
        }
        const all = ROMANIA_CITIES.map((city) => city.name).join("").toLowerCase();
        for (const letter of ["ă", "â", "î", "ș", "ț"]) assert.ok(all.includes(letter), `some name uses ${letter}`);
        assert.ok(ROMANIA_CITIES.some((city) => city.name === "Târgu Mureș") && ROMANIA_CITIES.some((city) => city.name === "Râmnicu Vâlcea"));
    });

    test("CITY-DATA-005 Bucharest is listed, is the reference point and is 0 km from itself", () => {
        const bucharest = findRomanianCity("Bucharest");
        assert.equal(bucharest.name, "București");
        assert.equal(bucharest.kind, "M");
        assert.deepEqual([bucharest.lat, bucharest.lon], [BUCHAREST.lat, BUCHAREST.lon]);
        assert.equal(bucharest.distanceKm, 0);
        assert.equal(findRomanianCity("bucuresti"), bucharest);
        assert.equal(ROMANIA_CITIES.filter((city) => city.distanceKm === 0).length, 1, "only Bucharest is at 0 km");
    });

    test("CITY-DATA-006 every county seat is listed (all 41 counties), and so are small towns of many counties", () => {
        const seats = ["Alba Iulia", "Alexandria", "Arad", "Bacău", "Baia Mare", "Bistrița", "Botoșani", "Brăila", "Brașov", "Buzău", "Călărași", "Cluj-Napoca", "Constanța", "Craiova", "Deva",
            "Drobeta-Turnu Severin", "Focșani", "Galați", "Giurgiu", "Iași", "Miercurea Ciuc", "Oradea", "Piatra Neamț", "Pitești", "Ploiești", "Râmnicu Vâlcea", "Reșița", "Satu Mare",
            "Sfântu Gheorghe", "Sibiu", "Slatina", "Slobozia", "Suceava", "Târgoviște", "Târgu Jiu", "Târgu Mureș", "Timișoara", "Tulcea", "Vaslui", "Zalău", "București"];
        assert.equal(seats.length, 41);
        for (const seat of seats) assert.ok(findRomanianCity(seat), `${seat} is missing`);
        // Towns the previous, partial list did not have (Tulcea, Constanța, Maramureș, Harghita, Caraș-Severin, Mehedinți, Dâmbovița, Vâlcea, Neamț, Vrancea, Olt ...).
        for (const town of ["Sulina", "Techirghiol", "Băile Herculane", "Vlăhița", "Băile Olănești", "Târgu Neamț", "Panciu", "Bălcești", "Moldova Nouă", "Vișeu de Sus", "Pucioasa", "Corabia", "Hârșova", "Negrești-Oaș", "Ocna Mureș"]) {
            assert.ok(findRomanianCity(town), `${town} is missing`);
        }
    });
});

describe("dataset: search and distance", () => {
    test("CITY-DATA-007 search ignores accents, capitals, hyphens and cedilla / comma-below forms", () => {
        assert.equal(findRomanianCity("TIMISOARA").name, "Timișoara");
        assert.equal(findRomanianCity("timişoara").name, "Timișoara", "cedilla ş typed by the candidate");
        assert.equal(findRomanianCity("Constanţa").name, "Constanța");
        assert.equal(findRomanianCity("  targu   mures ").name, "Târgu Mureș");
        assert.equal(findRomanianCity("cluj napoca").name, "Cluj-Napoca");
        assert.equal(findRomanianCity("Drobeta Turnu Severin").name, "Drobeta-Turnu Severin");
        assert.equal(findRomanianCity("RAMNICU VALCEA").name, "Râmnicu Vâlcea");
        assert.equal(findRomanianCity("Stefanesti (Botosani)").name, "Ștefănești (Botoșani)");
        assert.equal(findRomanianCity("Ștefănești"), null, "an ambiguous name is not guessed: it needs its county");
    });

    test("CITY-DATA-008 an unlisted place or a village is not a listed city (safety fallback only)", () => {
        for (const place of ["Atlantis", "Satu Nou", "Berceni", "", "   "]) assert.equal(findRomanianCity(place), null, place);
        assert.equal(findRomanianCity(undefined), null);
    });

    test("CITY-DATA-009 the Haversine distance still works: symmetric, whole km, plausible, 111 km per degree of latitude", () => {
        assert.equal(Math.round(haversineKm({ lat: 44, lon: 26 }, { lat: 45, lon: 26 })), 111);
        assert.equal(haversineKm(BUCHAREST, BUCHAREST), 0);
        const cluj = findRomanianCity("Cluj-Napoca");
        assert.equal(Math.round(haversineKm(cluj, BUCHAREST)), cluj.distanceKm);
        assert.equal(Math.round(haversineKm(BUCHAREST, cluj)), cluj.distanceKm);
        for (const [name, low, high] of [["Cluj-Napoca", 315, 330], ["Constanța", 195, 215], ["Timișoara", 400, 420], ["Brașov", 130, 150], ["Ploiești", 50, 65], ["Giurgiu", 55, 70], ["Sulina", 280, 300]]) {
            const { distanceKm } = findRomanianCity(name);
            assert.ok(distanceKm >= low && distanceKm <= high, `${name}: ${distanceKm} km`);
        }
        for (const city of ROMANIA_CITIES) assert.ok(Number.isInteger(city.distanceKm) && city.distanceKm >= 0 && city.distanceKm < 600, `${city.name}: ${city.distanceKm}`);
    });

    test("CITY-DATA-010 the server stores a listed city in its official spelling with its distance, and an unlisted one as typed with none", () => {
        const answers = () => ({
            basic: { fullName: "a", surname: "b", otherNames: "n/a", sex: "FEMALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "x", bloodGroup: "O+", height: "175", weight: "70", drivingLicence: "YES", canReadDrawings: "NO", teamLeadingSkills: "YES", otherLanguages: "n/a" },
            contact: { address: "a", city: "b", district: "c", dsDivision: "d", gnDivision: "e", alternativePhone: "n/a", email: "a@example.com", cityInRomania: "x" },
            passport: { issueDate: "2020-01-15", expiryDate: "2030-01-14" },
            qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "n/a", otherSkills1: "n/a", otherSkills2: "n/a", englishKnowledge: "GOOD" },
            measurements: { shirtSize: "M", waistSize: "32", shoeSize: "9" },
            family: { father: { name: "n/a", surname: "", passportNumber: "", birthDate: "" }, mother: { name: "n/a", surname: "", passportNumber: "", birthDate: "" }, spouse: { name: "", surname: "", passportNumber: "", birthDate: "" }, child1: "n/a", child2: "", child3: "", fatherAlive: "NO", motherAlive: "NO" },
            guardian: { name: "k", relationship: "u", nic: "901234567v", birthDate: "1960-01-01", phone: "0771234567", address: "a" },
        });
        const values = (city) => {
            const body = answers();
            body.contact.cityInRomania = city;
            const parsed = parseSubmission({ answers: body, idempotencyKey: "key-dataset-0000001" }, { now: new Date("2026-10-20T06:00:00Z") });
            assert.equal(parsed.errors, undefined, JSON.stringify(parsed.errors));
            return [parsed.values.cityInRomania, parsed.values.distanceToBucharestKm];
        };
        assert.deepEqual(values("sulina"), ["Sulina", findRomanianCity("Sulina").distanceKm]);
        assert.deepEqual(values("Ștefănești (Argeș)"), ["Ștefănești (Argeș)", findRomanianCity("Ștefănești (Argeș)").distanceKm]);
        assert.deepEqual(values("Satu Nou"), ["Satu Nou", null]);
    });
});
