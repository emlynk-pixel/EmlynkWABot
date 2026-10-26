import type { RomanianCity } from "../types/api";

// City in Romania: the listed cities come from the server with the form (POST /form
// `romanianCities`), each with its APPROXIMATE straight-line distance to Bucharest. Here the
// typed name is only matched to show that distance; the server matches it again, stores the
// listed spelling and derives the distance itself (src/utils/romaniaCities.js). A city that is
// not listed is still a valid answer: it simply has no distance.

// The same folding as the server: no diacritics (ș / ş, ț / ţ, ă, â, î), no letter case,
// hyphens and repeated spaces as one space.
export const cityKey = (value: string) => value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[\s-]+/g, " ").trim();

export function findCity(cities: readonly RomanianCity[], value: string): RomanianCity | null {
    const key = cityKey(value);
    if (!key) return null;
    return cities.find((city) => [city.name, ...(city.aliases ?? [])].some((spelling) => cityKey(spelling) === key)) ?? null;
}

// A place name: letters of any alphabet (Romanian ă â î ș ț included), spaces, dots, hyphens, apostrophes
// and parentheses (a listed name that shares its spelling carries its county: "Ștefănești (Argeș)").
export const CITY_PATTERN = /^\p{L}[\p{L}\p{M} .'’()-]*$/u;
export const MAX_CITY_LENGTH = 100;
