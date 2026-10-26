// Regenerates src/utils/romaniaCitiesData.js: every Romanian URBAN locality (the 103 municipalities,
// Bucharest included, and the 216 towns) from Wikidata, which carries each one's SIRUTA code
// (property P843, the official INS / National Institute of Statistics locality code), its
// Romanian name with comma-below diacritics, and its coordinates.
//
//   node scripts/generateRomaniaCities.mjs            (queries query.wikidata.org)
//   node scripts/generateRomaniaCities.mjs saved.json (a saved SPARQL JSON result)
//
// Run it only when the administrative list changes (a locality is declared a town). It prints the
// counts and refuses to write unless they are the expected 103 + 216, every row has a SIRUTA code
// and coordinates inside Romania, and no SIRUTA code or name is repeated. Review the diff before
// committing. Villages and communes are NOT included: the field is "Current City in Romania".

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "utils", "romaniaCitiesData.js");
const MUNICIPALITY = "Q640364"; // municipality of Romania
const TOWN = "Q16858213"; // town of Romania
const EXPECTED = { M: 103, T: 216 };
const QUERY = `SELECT ?item ?itemLabel ?type ?siruta ?coord ?countyLabel WHERE {
  VALUES ?type { wd:${MUNICIPALITY} wd:${TOWN} }
  ?item wdt:P31 ?type . ?item wdt:P843 ?siruta . ?item wdt:P625 ?coord .
  OPTIONAL { ?item wdt:P131 ?county . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ro,en". }
}`;

async function load() {
    if (process.argv[2]) return JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(QUERY)}`;
    const response = await fetch(url, { headers: { Accept: "application/sparql-results+json", "User-Agent": "EmlynkCityDataset/1.0" } });
    if (!response.ok) throw new Error(`Wikidata answered ${response.status}`);
    return response.json();
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const round4 = (value) => Number(value.toFixed(4));
// A present-day county label ("Argeș"), not a historical or regional one.
const isCounty = (label) => !/^(județul|regiunea|bezirk|regatul|ținutul|plasa)\b/i.test(label);

// Wikidata points that a cross-check against GeoNames (an independent source) showed to be
// several km away from the town itself. Keyed by SIRUTA code; the value is the GeoNames point.
const CORRECTED_POINTS = Object.freeze({
    83632: { name: "Toplița (Harghita)", lat: 46.9243, lon: 25.3519 },
    40465: { name: "Victoria (Brașov)", lat: 45.7297, lon: 24.7028 },
});

const bindings = (await load()).results.bindings;
const items = new Map();
for (const row of bindings) {
    const id = row.item.value.split("/").pop();
    const item = items.get(id) ?? { name: row.itemLabel.value.trim(), kind: row.type.value.endsWith(MUNICIPALITY) ? "M" : "T", siruta: row.siruta.value, points: new Set(), counties: new Set() };
    const match = /^Point\((-?[\d.]+) (-?[\d.]+)\)$/.exec(row.coord.value);
    if (!match) throw new Error(`Unreadable coordinate for ${item.name}`);
    item.points.add(`${match[2]},${match[1]}`);
    if (row.countyLabel && isCounty(row.countyLabel.value)) item.counties.add(row.countyLabel.value);
    items.set(id, item);
}

const cities = [...items.values()].map((item) => {
    const points = [...item.points].map((point) => point.split(",").map(Number));
    // A few towns have two nearly identical points in Wikidata: use their mean.
    const corrected = CORRECTED_POINTS[item.siruta];
    return { ...item, lat: corrected?.lat ?? round4(mean(points.map((p) => p[0]))), lon: corrected?.lon ?? round4(mean(points.map((p) => p[1]))) };
});

const problems = [];
const count = (kind) => cities.filter((city) => city.kind === kind).length;
if (count("M") !== EXPECTED.M || count("T") !== EXPECTED.T) problems.push(`expected ${EXPECTED.M} municipalities and ${EXPECTED.T} towns, got ${count("M")} and ${count("T")}`);
if (new Set(cities.map((city) => city.siruta)).size !== cities.length) problems.push("a SIRUTA code is repeated");
for (const city of cities) {
    if (!/^\d{1,7}$/.test(city.siruta)) problems.push(`${city.name}: bad SIRUTA ${city.siruta}`);
    if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(city.name) || /[şţŞŢ]/.test(city.name)) problems.push(`malformed name ${city.name}`);
    if (!(city.lat > 43.5 && city.lat < 48.3 && city.lon > 20.2 && city.lon < 29.8)) problems.push(`${city.name}: coordinates outside Romania`);
}
// The same name for two localities: add the county, so a name identifies one locality.
const byName = Map.groupBy(cities, (city) => city.name);
for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const city of group) {
        const [county] = [...city.counties];
        if (group.length > 1 && !county) problems.push(`${city.name} is repeated and has no county`);
        city.name = `${city.name} (${county})`;
    }
}
if (new Set(cities.map((city) => city.name)).size !== cities.length) problems.push("a name is still repeated");
if (problems.length) {
    console.error(`Refusing to write:\n- ${problems.join("\n- ")}`);
    process.exit(1);
}

cities.sort((a, b) => a.name.localeCompare(b.name, "ro"));
const lines = cities.map((city) => `    [${JSON.stringify(city.name)}, ${city.lat}, ${city.lon}, ${city.siruta}, "${city.kind}"],`);
fs.writeFileSync(OUT, `// GENERATED by scripts/generateRomaniaCities.mjs (do not edit by hand).
// Every Romanian urban locality: ${count("M")} municipalities (Bucharest included) and ${count("T")} towns = ${cities.length}.
// Source: Wikidata, which carries each locality's SIRUTA code (the official INS / National Institute
// of Statistics code), its Romanian name and its coordinates. Villages and communes are not included.
// [name, latitude, longitude, SIRUTA code, "M" municipality | "T" town]. Coordinates are the
// locality centre, rounded to 4 decimals (about 11 m); a few were averaged from two close points.
// Two towns share a name (Ștefănești, in Argeș and in Botoșani): their names carry the county.

export const ROMANIA_URBAN_LOCALITIES = Object.freeze([
${lines.join("\n")}
]);
`);
console.log(`wrote ${cities.length} localities (${count("M")} municipalities, ${count("T")} towns) to ${OUT}`);
