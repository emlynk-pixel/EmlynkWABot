import type { WorkflowStatus } from "../../api/candidates";
import { ToneBadge, type Tone } from "../StatusBadge";

// The candidate list's Status: the backend-derived workflow status (src/services/candidateWorkflowStatus.js),
// shown as it comes. The code only picks the badge tone; the label is the server's.
const TONES: Record<WorkflowStatus["code"], Tone> = {
    REGISTERED: "pending",
    STOPPED_WITH_TEST: "critical",
    TEST_PASSED: "review",
    JOB_ASSIGNED: "review",
    CANDIDATE_DETAILS_COLLECTED: "review",
    FORM_SUBMITTED: "review",
    CANDIDATE_DETAILS_VERIFIED: "verified",
    ADDITIONAL_DETAILS_COLLECTED: "verified",
    DETAILS_VERIFIED: "verified",
    DOCUMENTS_VERIFIED: "verified",
    VISA_DOCUMENT_READY: "verified",
    VISA_SUBMITTED: "verified",
    VISA_APPROVED: "verified",
    DEPARTED: "verified",
    // Recorded final outcomes: the candidate is not going ahead.
    VISA_NOT_GOING: "critical",
    CANCELLED: "critical",
    REJECTED: "critical",
};

export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
    const { group, subStatus } = status;
    if (group && subStatus) {
        return (
            <ToneBadge tone={TONES[group.code] ?? "pending"}>
                {group.label}
                <span className="ml-1 opacity-75">· {subStatus.label}</span>
            </ToneBadge>
        );
    }
    return <ToneBadge tone={TONES[status.code] ?? "pending"}>{status.label}</ToneBadge>;
}
