import type { MessageKey } from "../i18n/translations";
import type { FormGroup } from "./model";

// The form journey has four stages: Verify (the verification page, before the
// form), then THREE form steps: Personal Details, Work & Family Details and
// Review & Submit. The six earlier sections are now headings inside the two
// data steps, not steps of their own: every field, rule and prefill is the same.
export type StepId = "personal" | "work" | "review";
export type SectionId = "basic" | "contact" | "passport" | "measurements" | "family" | "guardian";

// A section: a heading and the parts of the data (groups) it edits.
export type Section = { id: SectionId; title: MessageKey; groups: readonly FormGroup[]; step: StepId; important?: boolean };

export const SECTIONS: readonly Section[] = [
    { id: "basic", title: "step.basic", groups: ["basic"], step: "personal" },
    { id: "contact", title: "step.contact", groups: ["contact"], step: "personal" },
    { id: "passport", title: "step.passport", groups: ["passport", "qualifications"], step: "work" },
    { id: "measurements", title: "step.measurements", groups: ["measurements"], step: "work" },
    { id: "family", title: "step.family", groups: ["family"], step: "work", important: true },
    { id: "guardian", title: "step.guardian", groups: ["guardian"], step: "work" },
];

// `groups` are every part of the data a step edits (its errors are checked
// before Next). The review step edits nothing.
export type Step = { id: StepId; title: MessageKey; lead: MessageKey; sections: readonly Section[]; groups: readonly FormGroup[] };

const sectionsOf = (step: StepId) => SECTIONS.filter((section) => section.step === step);
const stepDef = (id: StepId, title: MessageKey, lead: MessageKey): Step => ({
    id, title, lead, sections: sectionsOf(id), groups: sectionsOf(id).flatMap((section) => section.groups),
});

export const STEPS: readonly Step[] = [
    stepDef("personal", "step.personal", "step.personal.lead"),
    stepDef("work", "step.work", "step.work.lead"),
    stepDef("review", "step.review", "step.review.lead"),
];

// The Verify stage comes before these steps, on its own page.
export const JOURNEY_OFFSET = 1;
export const JOURNEY_TOTAL = STEPS.length + JOURNEY_OFFSET;

export const sectionOf = (path: string): Section | undefined => SECTIONS.find((section) => section.groups.some((group) => path.startsWith(`${group}.`)));
export const stepOf = (path: string): Step | undefined => {
    const section = sectionOf(path);
    return section ? STEPS.find((step) => step.id === section.step) : undefined;
};
