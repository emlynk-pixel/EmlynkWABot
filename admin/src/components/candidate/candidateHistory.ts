import { STAGE_LABELS, variantLabel, type CallLogEntry, type CandidateActivity } from "../../api/candidates";
import { documentTypeLabel } from "../format";

// Candidate History: the calls and the candidate's activity as one timeline,
// newest first by when each happened (the call time, the activity's own time).
export type HistoryItem =
    | { type: "CALL_LOG"; id: string; occurredAt: string; call: CallLogEntry }
    | { type: "CANDIDATE_ACTIVITY"; id: string; occurredAt: string; activity: CandidateActivity };

export function historyTimeline(calls: CallLogEntry[], activity: CandidateActivity[]): HistoryItem[] {
    const items: HistoryItem[] = [
        ...calls.map((call): HistoryItem => ({ type: "CALL_LOG", id: `call:${call.callLogId}`, occurredAt: call.calledAt, call })),
        ...activity.map((a): HistoryItem => ({ type: "CANDIDATE_ACTIVITY", id: a.activityId, occurredAt: a.occurredAt, activity: a })),
    ];
    const time = (item: HistoryItem) => new Date(item.occurredAt).getTime() || 0;
    // Stable: equal times keep the server's order (calls first).
    return items.map((item, index) => ({ item, index })).sort((a, b) => time(b.item) - time(a.item) || a.index - b.index).map(({ item }) => item);
}

// The candidate fields a details update can name (candidateService.js
// CANDIDATE_AUDIT_FIELDS). firstName holds the other names, otherName the surname.
const FIELD_LABELS: Record<string, string> = {
    otherName: "Surname",
    firstName: "Other names",
    address: "Address",
    nic: "NIC",
    job: "Job types",
    jobExperience: "Job experience",
    whatsappNumber: "WhatsApp number",
    contactNumber: "Contact number",
    placeOfBirth: "Place of birth",
    dateOfBirth: "Date of birth",
    passportIssueDate: "Passport issue date",
    passportExpiryDate: "Passport expiry date",
    nationality: "Nationality",
    sex: "Sex",
};
const NAME_FIELDS = ["otherName", "firstName"];
const PASSPORT_FIELDS = ["placeOfBirth", "dateOfBirth", "passportIssueDate", "passportExpiryDate", "nationality", "sex"];

const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field;

function detailsTitle(fields: string[]): { title: string; detail: string | null } {
    if (fields.length === 1) return { title: `${fieldLabel(fields[0])} updated`, detail: null };
    const listed = fields.length ? fields.map(fieldLabel).join(", ") : null;
    if (fields.length && fields.every((f) => NAME_FIELDS.includes(f))) return { title: "Name updated", detail: null };
    if (fields.length && fields.every((f) => PASSPORT_FIELDS.includes(f))) return { title: "Passport details updated", detail: listed };
    return { title: "Candidate details updated", detail: listed };
}

function documentLabel(activity: CandidateActivity): string {
    const type = activity.documentType ? documentTypeLabel(activity.documentType) : "Document";
    const variant = variantLabel(activity.variant);
    return variant ? `${type} - ${variant}` : type;
}

const stageLabel = (activity: CandidateActivity) => (activity.stage ? STAGE_LABELS[activity.stage] ?? activity.stage : "Stage");

// A short line for the activity, an optional detail, and who or what did it
// ("by …", "via WhatsApp"); null when that is not on record (never guessed).
export function describeActivity(activity: CandidateActivity): { title: string; detail: string | null; byline: string | null } {
    const by = activity.actorName ? `by ${activity.actorName}` : null;
    switch (activity.kind) {
        case "DOCUMENT_RECEIVED":
            return {
                title: `${documentLabel(activity)} uploaded`,
                detail: null,
                byline: activity.source === "WHATSAPP" ? "via WhatsApp" : activity.source === "STAFF" ? by : null,
            };
        case "DOCUMENT_VERIFIED":
            return { title: `${documentLabel(activity)} verified`, detail: null, byline: by };
        case "DOCUMENT_REMOVED":
            return { title: `${documentLabel(activity)} removed`, detail: null, byline: by };
        case "CANDIDATE_REGISTERED":
            return { title: "Candidate registered", detail: null, byline: by };
        case "DETAILS_UPDATED":
            return { ...detailsTitle(activity.fields), byline: by };
        case "ADDITIONAL_DETAILS_UPDATED":
            return { title: "Additional details updated", detail: null, byline: by };
        case "STAGE_COMPLETED":
            return { title: `${stageLabel(activity)} marked complete`, detail: null, byline: by };
        case "STAGE_REOPENED":
            return { title: `${stageLabel(activity)} marked incomplete`, detail: null, byline: by };
        case "STAGE_UPDATED":
            return { title: `${stageLabel(activity)} updated`, detail: null, byline: by };
        case "CANDIDATE_FORM_SUBMITTED":
            return {
                title: "Candidate Form submitted",
                detail: activity.formLink === "JOB_GROUP" ? `Through the job form link${activity.jobCode ? ` (${activity.jobCode})` : ""}` : activity.formLink === "SINGLE" ? "Through the candidate's own form link" : null,
                byline: "by the candidate",
            };
        default:
            return { title: "Candidate updated", detail: null, byline: by };
    }
}
