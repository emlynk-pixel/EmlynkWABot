// Romanian cities and their APPROXIMATE distance to Bucharest, for the Candidate Form's
// "City in Romania" / "Distance to Bucharest" (candidateFormDataService.js).
//
// The distance is the STRAIGHT-LINE (great-circle, Haversine) distance between the city's
// centre and Bucharest's, rounded to the nearest whole kilometre. It is NOT a driving or
// road distance (that would need a routing service, which this project does not use): it is
// always shown as "Approx." and labelled as a straight-line distance.
//
// The list is COMPLETE: every Romanian urban locality, the 103 municipalities (Bucharest included)
// and the 216 towns, 319 in all (romaniaCitiesData.js, generated from the official SIRUTA-coded
// administrative list by scripts/generateRomaniaCities.mjs). Villages and communes are not
// cities and are not listed. A place that is not listed is still accepted as typed (a safety
// fallback, e.g. a locality declared a town after the list was generated); it simply has no
// distance (null), so no value is ever guessed.

import { ROMANIA_URBAN_LOCALITIES } from "./romaniaCitiesData.js";

// Bucharest (Piata Universitatii). The ONE place the reference point is defined.
export const BUCHAREST = Object.freeze({ name: "București", lat: 44.4355, lon: 26.1025 });

const EARTH_RADIUS_KM = 6371;

// Other spellings a candidate may type (accents and capitals never matter: cityKey).
const ALIASES = Object.freeze({ București: ["Bucharest"] });

const toRadians = (degrees) => (degrees * Math.PI) / 180;

// Great-circle distance in km between two { lat, lon } points (Haversine), unrounded.
export function haversineKm(a, b) {
    const dLat = toRadians(b.lat - a.lat);
    const dLon = toRadians(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The approximate straight-line distance to Bucharest, whole km.
export const distanceToBucharestKm = (point) => Math.round(haversineKm(point, BUCHAREST));

// A spelling folded for matching: no diacritics (ș and ş, ț and ţ, ă, â, î alike), no letter
// case, and hyphens / repeated spaces as one space. "cluj napoca" matches "Cluj-Napoca".
export const cityKey = (value) => String(value)
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[\s-]+/g, " ")
    .trim();

// Bucharest always sits exactly on BUCHAREST (the reference point), so its distance is 0 km.
export const ROMANIA_CITIES = Object.freeze(ROMANIA_URBAN_LOCALITIES.map(([name, lat, lon, siruta, kind]) => {
    const point = name === BUCHAREST.name ? { lat: BUCHAREST.lat, lon: BUCHAREST.lon } : { lat, lon };
    return Object.freeze({ name, ...point, siruta, kind, aliases: Object.freeze(ALIASES[name] ?? []), distanceKm: distanceToBucharestKm(point) });
}));

const BY_KEY = new Map();
for (const city of ROMANIA_CITIES) for (const spelling of [city.name, ...city.aliases]) BY_KEY.set(cityKey(spelling), city);

// The listed city a typed name means (any letter case, with or without diacritics), or null.
export const findRomanianCity = (value) => (typeof value === "string" ? BY_KEY.get(cityKey(value)) ?? null : null);
