import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type CandidateDetails } from "../api/candidates";
import type { FollowUpList } from "../api/followUps";
import {
    ALL_ROLES, CANDIDATE_LIST_ROLES, FOLLOW_UP_ROLES, FOLLOW_UP_VIEW_ROLES, canListCandidates, canManageAllocations, canManageCandidates, canManageMasterData, canRegisterCandidates,
    canViewCandidates, canViewDailyReport, canViewDashboard, canViewFollowUps, canViewOverview, canViewJobs, canWorkFollowUps, hasRole, isAdmin, landingPath,
} from "../auth/roles";
import { NAV_ITEMS } from "../layout/navigation";
import { RENDER_STEP, renderApp, signedInBackend, userWithRole, type FetchRoutes, expectRedirectedHome } from "./helpers";

// What each narrowed role is offered: the sidebar, the landing page, the notification bell and the
// pages it may open by URL, which must match the backend tiers (src/routes/admin.js; enforced in
// test/roleScopeRegression.test.js). TEAM_LEAD's bell reads Need Attention, never the Review Queue;
// REGISTRATION_DESK has the registration workflow (Add Candidate) only; JOB_HANDLER views candidates without
// changing them; ANALYST has Candidates (allocated only) and Need Attention. A page a role can't
// open takes it to its home page, with no warning. Synthetic data; the backend is a stub.

const navLinks = () => within(screen.getByRole("navigation", { name: "Main navigation" })).getAllByRole("link").map((link) => link.textContent);
const PAGE = { page: 1, pageSize: 100, total: 0, totalPages: 1 };
const OPEN_FOLLOW_UPS: FollowUpList = {
    status: "OPEN",
    total: 1,
    truncated: false,
    groups: [{
        candidate: { passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", whatsappNumber: null, contactNumber: null },
        documentStatus: [],
        followUps: [{
            followUpId: "f-1", status: "OPEN", flaggedAt: "2026-10-07T05:00:00.000Z", flaggedByName: "Ann Analyst", completedAt: null, completedByName: null,
            callLog: { callLogId: "call-1", note: "Medical not uploaded", calledAt: "2026-10-07T04:00:00.000Z", adminName: "Ann Analyst" },
        }],
    }],
};
const DETAILS = {
    verification: { details: null, documents: null },
    candidate: {
        passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], surname: "SILVA", otherNames: "SAMAN",
        dateOfBirth: "1990-03-12", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", passportIssueDate: "2020-05-12", nationality: null, sex: null,
        address: "1 Main Street", jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null,
    },
    stages: CANDIDATE_STAGES.map((stage) => ({
        stage, completed: false, completedAt: null, notes: null, testAgentName: null, testId: null, jobDate: null, jobCode: null, clientName: null,
        jobSource: null, jobStatus: null, testResult: null, testDate: null, automatic: stage === "CANDIDATE_DETAILS" || stage === "DOCUMENT_SUBMISSION", missing: [],
    })),
    documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null, VISA_SUBMISSION: null },
    variantDocuments: { POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null } },
    jobAssignments: { current: null, history: [] },
    requiredDocuments: [],
} as unknown as CandidateDetails;
const CALL_LOGS = { items: [{ callLogId: "call-1", note: "Asked for the medical", calledAt: "2026-10-07T04:00:00.000Z", adminName: "Dee Desk", followUp: null }], activity: [] };

function backend(role: string, routes: FetchRoutes = {}) {
    return signedInBackend({
        "GET /auth/me": { status: 200, body: { user: userWithRole(role) } },
        "GET /api/admin/candidates": { status: 200, body: { items: [], pagination: PAGE, filters: { search: null } } },
        "GET /api/admin/follow-ups": { status: 200, body: OPEN_FOLLOW_UPS },
        "GET /api/admin/notifications/unread-count": { status: 200, body: { unreadCount: 1 } },
        "GET /api/admin/notifications": { status: 200, body: { items: [{ id: "n-1", type: "GENERIC", title: "Server notice", message: "From the server feed", createdAt: "2026-10-07T05:00:00.000Z", readAt: null }], unreadCount: 1, nextCursor: null } },
        "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
        "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALL_LOGS },
        ...routes,
    });
}
const requested = (calls: { path: string }[], pattern: RegExp) => calls.some((c) => pattern.test(c.path));

describe("roles.ts: the shared permission mapping", () => {
    test("the Candidates list, a candidate's page, changing a candidate and Need Attention, per role", () => {
        const can = (role: string) => {
            const user = userWithRole(role);
            return [canListCandidates(user), canViewCandidates(user), canManageCandidates(user), canViewFollowUps(user), canWorkFollowUps(user)];
        };
        for (const role of ["OWNER", "ADMIN", "TEAM_LEAD", "ANALYST"]) expect(can(role), role).toEqual([true, true, true, true, true]);
        expect(can("JOB_HANDLER")).toEqual([true, true, false, false, false]);
        expect(can("REGISTRATION_DESK")).toEqual([false, false, false, false, false]);
        expect(can("MANAGER")).toEqual([false, false, false, false, false]);
        expect(CANDIDATE_LIST_ROLES).toEqual(["ADMIN", "TEAM_LEAD", "ANALYST", "JOB_HANDLER"]);
        expect([FOLLOW_UP_VIEW_ROLES, FOLLOW_UP_ROLES]).toEqual([["ADMIN", "TEAM_LEAD", "ANALYST"], ["ADMIN", "TEAM_LEAD", "ANALYST"]]);
    });

    test("landing pages (also where a page a role can't open takes it)", () => {
        const land = (role: string) => landingPath(userWithRole(role));
        // The Overview roles (ADMIN, TEAM_LEAD, ANALYST) land on the Overview (null); the others are unchanged.
        expect([land("OWNER"), land("ADMIN"), land("TEAM_LEAD"), land("ANALYST")]).toEqual([null, null, null, null]);
        expect([land("REGISTRATION_DESK"), land("JOB_HANDLER")]).toEqual(["/candidates/new", "/jobs"]);
    });

    test("every sidebar entry opens to exactly the roles its page guard admits (no link to an Access Restricted page, no page without its link)", () => {
        // The page guard of each sidebar entry: App.tsx AllowRoles, or the page's own check.
        const guards: Record<string, (user: { role: string }) => boolean> = {
            "/": canViewOverview, "/documents": canViewDashboard, "/missing-documents": canViewDashboard, "/review": canViewDashboard, "/police": canViewDashboard,
            "/candidates": canListCandidates, "/candidates/new": canRegisterCandidates, "/follow-ups": canViewFollowUps,
            "/work-allocation": canManageAllocations, "/jobs": canViewJobs, "/agents": canManageMasterData, "/client-management": canManageMasterData,
            "/reports/daily": canViewDailyReport, "/audit-logs": isAdmin, "/settings": isAdmin,
        };
        expect(NAV_ITEMS.map((item) => item.to).sort()).toEqual(Object.keys(guards).sort());
        for (const role of [...ALL_ROLES, "MANAGER"]) {
            const user = userWithRole(role);
            for (const item of NAV_ITEMS) {
                const shown = hasRole(user, item.roles);
                // Add Candidate is the Registration Desk's own entry; the other registering roles reach it from Candidates and the header.
                if (item.to === "/candidates/new") expect(!shown || guards[item.to](user), `${role} ${item.to}`).toBe(true);
                else expect(shown, `${role} ${item.to}`).toBe(guards[item.to](user));
            }
        }
    });

    test("every sidebar entry names its roles explicitly (never TEAM_LEAD through ADMIN)", () => {
        const visible = (role: string) => NAV_ITEMS.filter((item) => (item.roles as readonly string[]).includes(role)).map((item) => item.label);
        expect(visible("TEAM_LEAD")).toEqual(["Overview", "Candidates", "Need Attention", "Work Allocation", "Jobs", "Agents", "Client Management", "Daily Report"]);
        expect(visible("REGISTRATION_DESK")).toEqual(["Add Candidate"]);
        expect(visible("JOB_HANDLER")).toEqual(["Candidates", "Jobs", "Agents", "Client Management"]);
    });
});

describe("TEAM_LEAD: the notification bell", () => {
    test("the bell reads the server notification feed, with no navigation; no Review Queue or follow-up request", { timeout: 20_000 }, async () => {
        const { calls } = backend("TEAM_LEAD");
        renderApp("/candidates");
        const bell = await screen.findByRole("button", { name: "Notifications (1 unread)" }, RENDER_STEP);
        expect(requested(calls, /^\/api\/admin\/notifications\/unread-count$/)).toBe(true);
        const user = userEvent.setup();
        await user.click(bell);
        expect(await screen.findByText("Server notice")).toBeInTheDocument();
        expect(screen.getByText("From the server feed")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Open Need Attention" })).not.toBeInTheDocument();
        expect(requested(calls, /\/api\/admin\/(review|overview|users|settings|audit-logs)/)).toBe(false);
    });

    test("lands on the Overview, its own view (\"My Overview\")", { timeout: 20_000 }, async () => {
        const { calls } = backend("TEAM_LEAD");
        renderApp("/");
        await expectRedirectedHome("TEAM_LEAD");
        expect(navLinks()[0]).toBe("Overview");
        await waitFor(() => expect(requested(calls, /^\/api\/admin\/overview\?view=mine$/)).toBe(true), RENDER_STEP);
    });

    test("forbidden pages are blocked by URL (to the Overview), with no request for their data", { timeout: 60_000 }, async () => {
        for (const path of ["/review", "/review/pending-1", "/documents", "/missing-documents", "/police", "/clients", "/settings", "/audit-logs"]) {
            const { calls } = backend("TEAM_LEAD");
            const { unmount } = renderApp(path);
            await expectRedirectedHome("TEAM_LEAD");
            expect(requested(calls, /\/api\/admin\/(review|documents|police|clients|users|settings|audit-logs)/), path).toBe(false);
            unmount();
        }
    });
});

describe("REGISTRATION_DESK: the registration workflow only", () => {
    test("the sidebar is Add Candidate only; it lands on Add Candidate; the bell; the form links nowhere else", { timeout: 20_000 }, async () => {
        const { calls } = backend("REGISTRATION_DESK");
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Add candidate", level: 1 }, RENDER_STEP)).toBeInTheDocument();
        expect(navLinks()).toEqual(["Add Candidate"]);
        await userEvent.setup().click(await screen.findByRole("button", { name: /^Notifications/ }));
        expect(await screen.findByText("Server notice")).toBeInTheDocument();
        expect(within(screen.getByRole("main")).queryByRole("link", { name: "Candidates" })).not.toBeInTheDocument();
        expect(requested(calls, /\/api\/admin\/(candidates\?|candidates$|review|overview|follow-ups)/)).toBe(false);
    });

    test("every other page is blocked by URL (the candidate page included), with no request for its data", { timeout: 60_000 }, async () => {
        for (const path of ["/follow-ups", "/candidates", "/candidates/N0000002", "/work-allocation", "/jobs", "/agents", "/client-management", "/settings", "/audit-logs", "/reports/daily", "/review", "/documents", "/police"]) {
            const { calls } = backend("REGISTRATION_DESK");
            const { unmount } = renderApp(path);
            await expectRedirectedHome("REGISTRATION_DESK");
            expect(requested(calls, /\/api\/admin\/(follow-ups|candidates|work-allocation|jobs|agents|client-management|settings|audit-logs|reports|review|documents|police)/), path).toBe(false);
            unmount();
        }
    });
});

describe("JOB_HANDLER: views candidates, changes none", () => {
    test("Candidates in the sidebar; the candidate's workflow opens read only, with a read-only call log", { timeout: 20_000 }, async () => {
        backend("JOB_HANDLER");
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
        expect(await screen.findByRole("heading", { name: "SAMAN SILVA" }, RENDER_STEP)).toBeInTheDocument();
        expect(navLinks()).toEqual(["Candidates", "Jobs", "Agents", "Client Management"]);
        await waitFor(() => expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0));
        for (const box of screen.getAllByRole("textbox") as HTMLInputElement[]) expect(box.disabled || box.readOnly, box.id).toBe(true);
        expect(screen.queryByRole("button", { name: /^Save changes/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole("button", { name: "Call log" }));
        const dialog = await screen.findByRole("dialog");
        expect(await within(dialog).findByText("Asked for the medical")).toBeInTheDocument();
        for (const name of [/Add call/, /No Answer/, /Need Attention/, /Mark as needs attention/]) expect(within(dialog).queryByRole("button", { name })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /^Notifications/ })).toBeInTheDocument();
    });

    test("Need Attention and the other non-job pages stay blocked", { timeout: 60_000 }, async () => {
        for (const path of ["/follow-ups", "/candidates/new", "/work-allocation", "/reports/daily", "/review"]) {
            const { calls } = backend("JOB_HANDLER");
            const { unmount } = renderApp(path);
            await expectRedirectedHome("JOB_HANDLER");
            expect(requested(calls, /\/api\/admin\/(follow-ups|work-allocation|reports|review)/), path).toBe(false);
            unmount();
        }
    });
});

describe("ANALYST", () => {
    test("Overview, Candidates and Need Attention only; lands on the Overview; the bell reads the server notification feed, never the Review Queue", { timeout: 20_000 }, async () => {
        const { calls } = backend("ANALYST");
        renderApp("/");
        await expectRedirectedHome("ANALYST");
        expect(navLinks()).toEqual(["Overview", "Candidates", "Need Attention"]);
        // An Analyst never asks for a view (the server serves its own, "mine").
        await waitFor(() => expect(requested(calls, /^\/api\/admin\/overview$/)).toBe(true), RENDER_STEP);
        expect(requested(calls, /^\/api\/admin\/overview\?/)).toBe(false);
        expect(await screen.findByRole("button", { name: "Notifications (1 unread)" }, RENDER_STEP)).toBeInTheDocument();
        expect(requested(calls, /^\/api\/admin\/notifications\/unread-count$/)).toBe(true);
        expect(requested(calls, /\/api\/admin\/(review|reports|jobs|documents|police)/)).toBe(false);
    });

    test("every other page takes it to the Overview, with no warning and no request for the page's data", { timeout: 60_000 }, async () => {
        for (const path of ["/review", "/review/pending-1", "/documents", "/missing-documents", "/police", "/clients", "/clients/N0000002", "/reports/daily", "/jobs", "/jobs/x", "/work-allocation", "/agents", "/client-management", "/candidates/new", "/settings", "/audit-logs"]) {
            const { calls } = backend("ANALYST");
            const { unmount } = renderApp(path);
            await expectRedirectedHome("ANALYST");
            expect(requested(calls, /\/api\/admin\/(review|reports|jobs|documents|police|clients|work-allocation|agents|client-management|settings|audit-logs|users)/), path).toBe(false);
            unmount();
        }
    });

    test("a candidate outside the allocation (the server answers 404) shows nothing of it", { timeout: 20_000 }, async () => {
        backend("ANALYST", { "GET /api/admin/candidates/N0000009": { status: 404, body: { message: "Candidate not found" } } });
        renderApp("/candidates/N0000009");
        expect(await screen.findByText("Candidate not found", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Call log" })).not.toBeInTheDocument();
    });
});
