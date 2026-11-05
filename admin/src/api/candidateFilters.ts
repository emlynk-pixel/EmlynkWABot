import { apiRequest } from "./client";
import { CANDIDATE_STAGES, SEX_OPTIONS, STAGE_LABELS, type WorkflowStatus } from "./candidates";

// Advanced candidate filters (src/services/candidateListFilters.js), shared by Admin > Candidates and
// Work Allocation. The server applies every one of them before paging, AND-ed with each other, the
// quick search and the user's candidate scope; the page never filters rows itself.
//
// Values are kept as the query strings the server takes: a list is comma-separated ("A,B"), a date is
// YYYY-MM-DD, a text filter has an optional "<field>Match" (contains is the default).

export type TextMatch = "contains" | "startsWith" | "equals";
export const TEXT_MATCH_LABELS: Record<TextMatch, string> = { contains: "Contains", startsWith: "Starts with", equals: "Is exactly" };

export const TEXT_FILTERS = [
    { key: "name", label: "Full name", matches: ["contains"] },
    { key: "surname", label: "Surname", matches: ["contains", "startsWith", "equals"] },
    { key: "otherNames", label: "Other names", matches: ["contains", "startsWith", "equals"] },
    { key: "passport", label: "Passport number", matches: ["contains", "startsWith", "equals"] },
    { key: "nic", label: "NIC", matches: ["contains", "startsWith", "equals"] },
    { key: "whatsapp", label: "WhatsApp number", matches: ["contains", "startsWith", "equals"] },
    { key: "nationality", label: "Nationality", matches: ["contains", "equals"] },
    { key: "jobCode", label: "Current job code", matches: ["contains", "equals"] },
] as const satisfies readonly { key: string; label: string; matches: readonly TextMatch[] }[];
export type TextFilterKey = (typeof TEXT_FILTERS)[number]["key"];

export const LIST_FILTER_KEYS = ["jobType", "workflowStatus", "stage", "sex", "analystId", "clientId", "agentId"] as const;
export type ListFilterKey = (typeof LIST_FILTER_KEYS)[number];

export const DATE_FILTERS = [
    { from: "registeredFrom", to: "registeredTo", label: "Registered date" },
    { from: "testFrom", to: "testTo", label: "Test date" },
] as const;

export type FilterKey =
    | TextFilterKey | `${TextFilterKey}Match` | ListFilterKey | "allocation"
    | (typeof DATE_FILTERS)[number]["from"] | (typeof DATE_FILTERS)[number]["to"];

export const FILTER_KEYS: readonly FilterKey[] = [
    ...TEXT_FILTERS.flatMap((field) => [field.key, `${field.key}Match` as const]),
    ...LIST_FILTER_KEYS,
    "allocation",
    ...DATE_FILTERS.flatMap((range) => [range.from, range.to]),
];

export type CandidateFilters = Partial<Record<FilterKey, string>>;

export type Choice = { value: string; label: string };

export const WORKFLOW_STATUS_CHOICES: { value: WorkflowStatus["code"]; label: string }[] = [
    { value: "REGISTERED", label: "Registered" },
    { value: "STOPPED_WITH_TEST", label: "Stopped with Test" },
    { value: "JOB_ASSIGNED", label: "Job Assigned" },
    { value: "FORM_SUBMITTED", label: "Form Submitted" },
    { value: "DETAILS_VERIFIED", label: "Details Verified" },
    { value: "DOCUMENTS_VERIFIED", label: "Documents Verified" },
    { value: "VISA_DOCUMENT_READY", label: "Visa Document Ready" },
    { value: "VISA_SUBMITTED", label: "Visa Submitted" },
    { value: "DEPARTED", label: "Departed" },
];
export const STAGE_CHOICES: Choice[] = [
    ...CANDIDATE_STAGES.map((stage) => ({ value: stage, label: STAGE_LABELS[stage] })),
    { value: "COMPLETE", label: "All stages completed" },
];
export const SEX_CHOICES: Choice[] = SEX_OPTIONS.map((option) => ({ value: option.value, label: option.label }));
export const ALLOCATION_CHOICES: Choice[] = [
    { value: "ALLOCATED", label: "Allocated" },
    { value: "UNALLOCATED", label: "Unallocated" },
];

// GET /api/admin/candidate-filter-options: only what the user's role may filter by (officers for
// ADMIN / TEAM_LEAD; clients and agents for the roles that read Jobs).
export type CandidateFilterOptions = {
    jobTypes: string[];
    noPreference: { code: string; label: string };
    officers?: { id: string; name: string; active: boolean }[];
    clients?: { id: string; name: string }[];
    agents?: { id: string; name: string }[];
};

export const getCandidateFilterOptions = (token: string, signal?: AbortSignal) =>
    apiRequest<CandidateFilterOptions>("/api/admin/candidate-filter-options", { token, signal });

export const listOf = (value: string | undefined | null): string[] => (value ? value.split(",").filter(Boolean) : []);

// Only the filters that are set (an operator alone is not a filter).
export function cleanFilters(filters: CandidateFilters): CandidateFilters {
    const clean: CandidateFilters = {};
    for (const key of FILTER_KEYS) {
        const value = filters[key]?.trim();
        if (value) clean[key] = value;
    }
    for (const field of TEXT_FILTERS) {
        const match = clean[`${field.key}Match`];
        if (!clean[field.key] || match === "contains") delete clean[`${field.key}Match`];
    }
    return clean;
}

export const filterCount = (filters: CandidateFilters) => filterChips(filters, null).length;

export const appendFilters = (query: URLSearchParams, filters: CandidateFilters | undefined) => {
    for (const [key, value] of Object.entries(cleanFilters(filters ?? {}))) query.set(key, value);
};

const formatYmd = (ymd: string) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

// The choices of a list filter (the system's own data for job types, officers, clients, agents).
export function listChoices(key: ListFilterKey, options: CandidateFilterOptions | null): Choice[] {
    switch (key) {
        case "jobType":
            return [
                ...(options?.jobTypes ?? []).map((name) => ({ value: name, label: name })),
                ...(options ? [{ value: options.noPreference.code, label: options.noPreference.label }] : []),
            ];
        case "workflowStatus": return WORKFLOW_STATUS_CHOICES;
        case "stage": return STAGE_CHOICES;
        case "sex": return SEX_CHOICES;
        case "analystId": return (options?.officers ?? []).map((officer) => ({ value: officer.id, label: officer.active ? officer.name : `${officer.name} (inactive)` }));
        case "clientId": return (options?.clients ?? []).map((client) => ({ value: client.id, label: client.name }));
        case "agentId": return (options?.agents ?? []).map((agent) => ({ value: agent.id, label: agent.name }));
    }
}

export const LIST_LABELS: Record<ListFilterKey, string> = {
    jobType: "Job type", workflowStatus: "Status", stage: "Current stage", sex: "Sex", analystId: "Officer", clientId: "Client", agentId: "Agent",
};

// One chip per applied filter: its label and the keys removing it clears (a text filter's
// operator, both ends of a date range).
export type FilterChip = { id: string; label: string; keys: FilterKey[] };

export function filterChips(filters: CandidateFilters, options: CandidateFilterOptions | null): FilterChip[] {
    const clean = cleanFilters(filters);
    const chips: FilterChip[] = [];
    for (const field of TEXT_FILTERS) {
        const value = clean[field.key];
        if (!value) continue;
        const match = (clean[`${field.key}Match`] ?? "contains") as TextMatch;
        chips.push({ id: field.key, label: `${field.label} ${TEXT_MATCH_LABELS[match].toLowerCase()} "${value}"`, keys: [field.key, `${field.key}Match`] });
    }
    for (const key of LIST_FILTER_KEYS) {
        const values = listOf(clean[key]);
        if (!values.length) continue;
        const choices = listChoices(key, options);
        const names = values.map((value) => choices.find((choice) => choice.value === value)?.label ?? value);
        chips.push({ id: key, label: `${LIST_LABELS[key]}: ${names.join(", ")}`, keys: [key] });
    }
    if (clean.allocation) {
        chips.push({ id: "allocation", label: `Allocation: ${ALLOCATION_CHOICES.find((choice) => choice.value === clean.allocation)?.label ?? clean.allocation}`, keys: ["allocation"] });
    }
    for (const range of DATE_FILTERS) {
        const from = clean[range.from];
        const to = clean[range.to];
        if (!from && !to) continue;
        const text = from && to ? `${formatYmd(from)} – ${formatYmd(to)}` : from ? `from ${formatYmd(from)}` : `until ${formatYmd(to!)}`;
        chips.push({ id: range.from, label: `${range.label.replace(" date", "")}: ${text}`, keys: [range.from, range.to] });
    }
    return chips;
}
