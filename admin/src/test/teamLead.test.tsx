import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
    ALL_ROLES, ROLES, assignableRoles, canConfirmSubmittedChanges, canCorrectPoliceDates, canCreateJobTypes, canDeleteFollowUps, canImportCandidates,
    canAssignJobFromCandidatePage, canManageAllocations, canManageCandidates, canManageJobs, canManageMasterData, canManageUser, canRegisterCandidates, canReview, canShareJobGroupForm,
    canVerifyCandidate, canViewCandidates, canViewDailyReport, canViewDashboard, canViewJobs, canViewRoleReport, canInviteUsers, invitableRoles, isAdmin, roleLabel,
} from "../auth/roles";
import { RENDER_STEP, renderApp, signedInBackend, userWithRole } from "./helpers";

// The TEAM_LEAD role in the admin app: exactly seven areas (not every ADMIN permission). Candidates
// (all of them), Need Attention, Work Allocation, Jobs, Agents, Clients and the standard Daily
// Report; every ADMIN-only action inside them stays ADMIN only; no Settings, user management, Audit
// Logs or dashboards. The backend enforces every rule (test/teamLeadRole.test.js); this checks what the
// screens offer. Synthetic data only.

const TL = userWithRole("TEAM_LEAD");
const navLinks = () => within(screen.getByRole("navigation", { name: "Main navigation" })).getAllByRole("link").map((link) => link.textContent);
const PAGE = { page: 1, pageSize: 100, total: 0, totalPages: 1 };

function backend() {
    return signedInBackend({
        "GET /auth/me": { status: 200, body: { user: TL } },
        "GET /api/admin/candidates": { status: 200, body: { items: [], pagination: PAGE, filters: { search: null } } },
    });
}

describe("roles.ts", () => {
    test("TEAM_LEAD is a role between Admin and the operational roles, labelled Team Lead", () => {
        expect(ALL_ROLES).toEqual(["OWNER", "ADMIN", "TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        expect(ROLES.TEAM_LEAD).toBe("TEAM_LEAD");
        expect(roleLabel("TEAM_LEAD")).toBe("Team Lead");
    });

    test("allowed: the operational areas", () => {
        for (const allowed of [canViewCandidates, canManageCandidates, canRegisterCandidates, canManageAllocations, canViewJobs, canManageJobs, canManageMasterData, canViewDailyReport]) {
            expect(allowed(TL), allowed.name).toBe(true);
        }
    });

    test("forbidden: every ADMIN-only action, administration, dashboards, review and Job Types (it inherits nothing from ADMIN)", () => {
        for (const refused of [isAdmin, canInviteUsers, canViewDashboard, canReview, canCorrectPoliceDates, canCreateJobTypes, canImportCandidates,
            canVerifyCandidate, canConfirmSubmittedChanges, canDeleteFollowUps, canShareJobGroupForm, canViewRoleReport, canAssignJobFromCandidatePage]) {
            expect(refused(TL), refused.name).toBe(false);
        }
        expect(assignableRoles(TL)).toEqual([]);
        expect(invitableRoles(TL)).toEqual([]);
        for (const role of ALL_ROLES) expect(canManageUser(TL, { userId: "x", role }), role).toBe(false);
    });

    test("OWNER and ADMIN may give the role; ADMIN still never gives ADMIN or OWNER", () => {
        expect(assignableRoles(userWithRole("OWNER"))).toEqual(["ADMIN", "TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        expect(assignableRoles(userWithRole("ADMIN"))).toEqual(["TEAM_LEAD", "ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]);
        expect(canManageUser(userWithRole("ADMIN"), { userId: "x", role: "TEAM_LEAD" })).toBe(true);
    });

    test("the other roles are unchanged", () => {
        const analyst = userWithRole("ANALYST");
        expect([canManageAllocations(analyst), canVerifyCandidate(analyst), canManageJobs(analyst), canManageMasterData(analyst)]).toEqual([false, false, false, false]);
        expect([canViewDailyReport(analyst), canViewRoleReport(analyst), canViewDashboard(analyst)]).toEqual([true, false, true]);
        const desk = userWithRole("REGISTRATION_DESK");
        expect([canManageAllocations(desk), canViewJobs(desk), canViewDailyReport(desk)]).toEqual([false, false, false]);
        const handler = userWithRole("JOB_HANDLER");
        expect([canManageCandidates(handler), canManageAllocations(handler), canShareJobGroupForm(handler), canManageJobs(handler)]).toEqual([false, false, false, true]);
        expect(canManageAllocations(userWithRole("MANAGER"))).toBe(false);
    });
});

describe("TEAM_LEAD in the admin app", () => {
    test("the sidebar has exactly the operational areas and lands on Candidates", { timeout: 20_000 }, async () => {
        const { calls } = backend();
        renderApp("/");
        await screen.findByRole("navigation", { name: "Main navigation" }, RENDER_STEP);
        await waitFor(() => expect(calls.some((c) => c.path.startsWith("/api/admin/candidates"))).toBe(true), RENDER_STEP);
        expect(navLinks()).toEqual(["Candidates", "Need Attention", "Work Allocation", "Jobs", "Agents", "Client Management", "Daily Report"]);
        for (const name of ["Overview", "Documents", "Review Queue", "Missing Documents", "Police Workflow", "Audit Logs", "Settings"]) {
            expect(within(screen.getByRole("navigation", { name: "Main navigation" })).queryByRole("link", { name })).not.toBeInTheDocument();
        }
        expect(screen.getByText("Team Lead")).toBeInTheDocument();
        expect(calls.some((c) => c.path.startsWith("/api/admin/overview") || c.path.startsWith("/api/admin/review"))).toBe(false);
    });

    test("Settings, Audit Logs and the dashboard pages are blocked, with no request for their data", { timeout: 60_000 }, async () => {
        for (const path of ["/settings", "/settings/roles", "/settings/invite", "/settings/sheet-sync", "/settings/job-types", "/invitations", "/audit-logs", "/documents", "/review", "/police", "/missing-documents", "/clients"]) {
            const { calls } = backend();
            const { unmount } = renderApp(path);
            expect((await screen.findAllByText(/Access Restricted|Only administrators/, {}, RENDER_STEP)).length, path).toBeGreaterThan(0);
            expect(calls.some((c) => /\/api\/admin\/(users|settings|audit-logs|documents|review|police|clients|overview)/.test(c.path)), path).toBe(false);
            unmount();
        }
    });
});
