import type { Message } from "../i18n/useLanguage";
import type { CandidateFormData } from "./model";
import type { FormErrors } from "./validation";
import { requiredPaths, valueAt } from "./validation";

// What every step gets: the data, a setter by path ("family.father.name"),
// the errors to show (already limited to the attempted steps), and which
// answers were prefilled from the candidate's record.
export type StepProps = {
    data: CandidateFormData;
    set: (path: string) => (value: string) => void;
    errors: FormErrors;
    prefilled: ReadonlySet<string>;
    // The job category choices (jobCategoryChoices: active job types + No Preferred Type + OTHER).
    jobCategories: readonly string[];
};

// The DOM id of a field: "basic.fullName" -> "basic-fullName".
export const idOf = (path: string) => path.replace(/\./g, "-");

// id, value, onChange, error and "required" for a field, ready to spread on an input.
// "required" comes from the same list the checks use (validation.ts requiredPaths),
// so the * mark and the check never disagree (a parent named N/A, later children).
export function bind({ data, set, errors, prefilled }: StepProps, path: string): { id: string; value: string; onChange: (value: string) => void; error?: Message; prefilled: boolean; required: boolean } {
    return { id: idOf(path), value: valueAt(data, path), onChange: set(path), error: errors[path], prefilled: prefilled.has(path), required: requiredPaths(data).includes(path) };
}

// A copy of `data` with one value replaced (paths are at most three deep).
export function setAt(data: CandidateFormData, path: string, value: string): CandidateFormData {
    const [group, field, sub] = path.split(".") as [keyof CandidateFormData, string, string | undefined];
    const section = data[group] as unknown as Record<string, unknown>;
    if (sub === undefined) return { ...data, [group]: { ...section, [field]: value } };
    const nested = section[field] as Record<string, string>;
    return { ...data, [group]: { ...section, [field]: { ...nested, [sub]: value } } };
}
