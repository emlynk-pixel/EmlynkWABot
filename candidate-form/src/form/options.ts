// The fixed choices of the Candidate Form. Every value is an English code:
// that code is what the form keeps and would send; only the label shown next
// to it is translated (translations.ts: "sex.MALE", "job.WELDER TIG", ...).
//
// To change a list, edit it here: the form, the review step and the tests
// follow. Job categories are the one list expected to come from the server
// later (useJobCategories below), so the component already takes them as
// data rather than importing this constant.

export const SEX_OPTIONS = ["MALE", "FEMALE", "OTHER"] as const;
export type Sex = (typeof SEX_OPTIONS)[number];

export const CIVIL_STATUS_OPTIONS = ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED"] as const;
export type CivilStatus = (typeof CIVIL_STATUS_OPTIONS)[number];

export const ENGLISH_LEVELS = ["NO KNOWLEDGE", "BASIC", "FAIR", "GOOD", "VERY GOOD", "FLUENT"] as const;
export type EnglishLevel = (typeof ENGLISH_LEVELS)[number];

// "OTHER" opens a free-text "Other Job Category"; that text is never added
// to this list.
export const OTHER_JOB_CATEGORY = "OTHER";

export const JOB_CATEGORIES = [
    "PLASTER",
    "BLOCK MASON",
    "TILER",
    "SHUTTERING CARPENTER",
    "BARBENDER",
    "GYPSUM WORKER",
    "ALUMINIUM WORKER",
    "WELDER TIG",
    "WELDER MIG",
    "WELDER ARC",
    "PLUMBER",
    "ELECTRICIAN",
    "JCB OPERATOR",
    "EXCAVATOR OPERATOR",
    "MOTOR GRADER OPERATOR",
    "BOBCAT OPERATOR",
    "WHEEL LOADER OPERATOR",
    OTHER_JOB_CATEGORY,
] as const;
export type JobCategoryCode = (typeof JOB_CATEGORIES)[number];

export const SHIRT_SIZES = ["XS", "S", "M", "L", "XL", "XXL"] as const;
// The "Size chart" under Shirt Size, in inches: the shirt's width and length, and the chest it fits, for
// every size the form offers (XXL carries the supplier chart's 2XL row). Reference only: it never
// changes the answer. chest is a range ("31–34").
export const SHIRT_SIZE_CHART_COLUMNS = ["width", "length", "chest"] as const;
export const SHIRT_SIZE_CHART: readonly { size: (typeof SHIRT_SIZES)[number]; values: readonly [string, string, string] }[] = [
    { size: "XS", values: ["17", "27", "31–34"] },
    { size: "S", values: ["18", "28", "36–39"] },
    { size: "M", values: ["20", "29", "39–42"] },
    { size: "L", values: ["22", "30", "42–45"] },
    { size: "XL", values: ["24", "31", "46–49"] },
    { size: "XXL", values: ["26", "32", "50–53"] },
];

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;
// A Yes / No answer (the server stores it as true / false).
export const YES_NO = ["YES", "NO"] as const;
// Waist in inches.
export const WAIST_SIZE_PRESETS = ["28", "30", "32", "34", "36", "38", "40", "42", "44", "46"] as const;
// European (EU) sizes: the answer is the EU size as listed ("42"). "Other" takes any other size.
// EU sizing only: the "Size guide" under it gives tips for finding the EU size, no other system.
export const SHOE_SIZE_PRESETS = ["38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48"] as const;

// "No Preferred Type": the candidate has no job type restriction (stored as this code).
export const NO_PREFERENCE = "NO_PREFERENCE";

// The job categories the form offers: the ACTIVE job types the server sends with
// the form (Settings > Job Types, POST /form `jobCategories`), then "No Preferred
// Type", then OTHER (always last; it opens "Other Job Category"). JOB_CATEGORIES
// above is only the list the job types were seeded from.
export function jobCategoryChoices(fromServer: readonly string[]): string[] {
    return [...fromServer.filter((name) => name !== OTHER_JOB_CATEGORY && name !== NO_PREFERENCE), NO_PREFERENCE, OTHER_JOB_CATEGORY];
}

// A category's label: its translation when there is one (the original trades,
// No Preferred Type, Other), otherwise the job type's own name (a type added
// later in Settings shows at once, in the administrators' spelling).
export function jobCategoryLabel(code: string, translations: Record<string, string>): string {
    return translations[`job.${code}`] ?? code;
}
