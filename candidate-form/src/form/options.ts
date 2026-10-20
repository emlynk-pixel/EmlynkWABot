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
// Waist in inches.
export const WAIST_SIZE_PRESETS = ["28", "30", "32", "34", "36", "38", "40", "42", "44", "46"] as const;
// UK sizes; "Other" takes any other size, e.g. "EU 43".
export const SHOE_SIZE_PRESETS = ["5", "6", "7", "8", "9", "10", "11", "12", "13"] as const;
// The "Size guide" next to Shoe Size: each listed UK size with the usual
// European (EU) size. A general reference only (brands differ); it never
// changes the answer, which stays a UK size from the list (or what the
// candidate types under Other, e.g. "EU 42").
export const SHOE_SIZE_GUIDE: readonly { uk: (typeof SHOE_SIZE_PRESETS)[number]; eu: string }[] = [
    { uk: "5", eu: "38" },
    { uk: "6", eu: "39" },
    { uk: "7", eu: "40–41" },
    { uk: "8", eu: "42" },
    { uk: "9", eu: "43" },
    { uk: "10", eu: "44" },
    { uk: "11", eu: "45–46" },
    { uk: "12", eu: "47" },
    { uk: "13", eu: "48" },
];

// Where the job categories come from. Today a local list; later the same
// shape from the API, without changing the component that shows them.
export type JobCategoriesSource = { status: "ready"; codes: readonly string[] } | { status: "loading" } | { status: "error" };

export function useJobCategories(): JobCategoriesSource {
    return { status: "ready", codes: JOB_CATEGORIES };
}
