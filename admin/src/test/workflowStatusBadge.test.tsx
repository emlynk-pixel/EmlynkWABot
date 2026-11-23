import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { WorkflowStatusBadge } from "../components/candidate/WorkflowStatusBadge";
import { WORKFLOW_STATUS_CHOICES, cleanFilters } from "../api/candidateFilters";

describe("WorkflowStatusBadge", () => {
    test("step 4 partial shows the group with its sub-status", () => {
        render(<WorkflowStatusBadge status={{
            code: "FORM_SUBMITTED", label: "Form Submitted",
            group: { code: "CANDIDATE_DETAILS_VERIFIED", label: "Candidate Details Verified" },
            subStatus: { code: "FORM_SUBMITTED", label: "Form Submitted" },
        }} />);
        expect(screen.getByText("Candidate Details Verified", { exact: false }).textContent).toBe("Candidate Details Verified· Form Submitted");
    });

    test("step 4 complete shows the plain label", () => {
        render(<WorkflowStatusBadge status={{ code: "CANDIDATE_DETAILS_VERIFIED", label: "Candidate Details Verified" }} />);
        expect(screen.getByText("Candidate Details Verified").textContent).toBe("Candidate Details Verified");
    });

    test("filter choices include the new codes, not Additional Details Collected", () => {
        const values = WORKFLOW_STATUS_CHOICES.map((c) => c.value);
        expect(values).toContain("CANDIDATE_DETAILS_COLLECTED");
        expect(values).toContain("CANDIDATE_DETAILS_VERIFIED");
        expect(values).not.toContain("ADDITIONAL_DETAILS_COLLECTED");
        expect(values).not.toContain("DETAILS_VERIFIED");
        expect(cleanFilters({ workflowStatus: "CANDIDATE_DETAILS_VERIFIED" })).toEqual({ workflowStatus: "CANDIDATE_DETAILS_VERIFIED" });
    });
});
