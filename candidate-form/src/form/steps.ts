import type { MessageKey } from "../i18n/translations";
import type { FormGroup } from "./model";

// The form, one section at a time. `groups` are the parts of the data a
// step edits (its errors are checked before Next). The review step edits
// nothing.
export type StepId = "basic" | "contact" | "passport" | "measurements" | "family" | "guardian" | "review";

export type Step = { id: StepId; title: MessageKey; lead: MessageKey; groups: readonly FormGroup[]; important?: boolean };

export const STEPS: readonly Step[] = [
    { id: "basic", title: "step.basic", lead: "step.basic.lead", groups: ["basic"] },
    { id: "contact", title: "step.contact", lead: "step.contact.lead", groups: ["contact"] },
    { id: "passport", title: "step.passport", lead: "step.passport.lead", groups: ["passport", "qualifications"] },
    { id: "measurements", title: "step.measurements", lead: "step.measurements.lead", groups: ["measurements"] },
    { id: "family", title: "step.family", lead: "step.family.lead", groups: ["family"], important: true },
    { id: "guardian", title: "step.guardian", lead: "step.guardian.lead", groups: ["guardian"] },
    { id: "review", title: "step.review", lead: "step.review.lead", groups: [] },
];

export const stepOf = (path: string): Step | undefined => STEPS.find((step) => step.groups.some((group) => path.startsWith(`${group}.`)));
