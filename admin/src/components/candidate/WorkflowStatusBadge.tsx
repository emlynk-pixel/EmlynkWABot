import type { WorkflowStatus } from "../../api/candidates";
import { ToneBadge, type Tone } from "../StatusBadge";

// The candidate list's Status: the backend-derived workflow status (src/services/candidateWorkflowStatus.js),
// shown as it comes. The code only picks the badge tone; the label is the server's.
const TONES: Record<WorkflowStatus["code"], Tone> = {
    REGISTERED: "pending",
    STOPPED_WITH_TEST: "critical",
    JOB_ASSIGNED: "review",
    FORM_SUBMITTED: "review",
    DETAILS_VERIFIED: "verified",
    DOCUMENTS_VERIFIED: "verified",
    VISA_DOCUMENT_READY: "verified",
};

export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
    return <ToneBadge tone={TONES[status.code] ?? "pending"}>{status.label}</ToneBadge>;
}
