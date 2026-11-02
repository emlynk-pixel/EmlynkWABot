import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type CandidateDetails } from "../api/candidates";
import type { FollowUpList } from "../api/followUps";
import {
    CANDIDATE_LIST_ROLES, FOLLOW_UP_ROLES, FOLLOW_UP_VIEW_ROLES, canListCandidates, canManageCandidates, canViewCandidates, canViewFollowUps, canWorkFollowUps, landingPath, notificationSource,
} from "../auth/roles";
import { NAV_ITEMS } from "../layout/navigation";
import { RENDER_STEP, renderApp, signedInBackend, userWithRole, type FetchRoutes } from "./helpers";

// What each narrowed role is offered: the sidebar, the landing page, the notification bell and the
// pages it may open by URL, which must match the backend tiers (src/routes/admin.js; enforced in
// test/roleScopeRegression.test.js). TEAM_LEAD's bell reads Need Attention, never the Review Queue;
// REGISTRATION_DESK has the registration workflow and a read-only Need Attention; JOB_HANDLER views candidates without
// changing them; ANALYST keeps its pages. Synthetic data; the backend is a stub.

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
        expect(can("REGISTRATION_DESK")).toEqual([false, false, false, true, false]);
        expect(can("MANAGER")).toEqual([false, false, false, false, false]);
        expect(CANDIDATE_LIST_ROLES).toEqual(["ADMIN", "TEAM_LEAD", "ANALYST", "JOB_HANDLER"]);
        expect([FOLLOW_UP_VIEW_ROLES, FOLLOW_UP_ROLES]).toEqual([["ADMIN", "TEAM_LEAD", "ANALYST", "REGISTRATION_DESK"], ["ADMIN", "TEAM_LEAD", "ANALYST"]]);
    });

    test("the bell's source: the review queue for its roles, Need Attention for TEAM_LEAD, none otherwise", () => {
        const source = (role: string) => notificationSource(userWithRole(role));
        expect(["OWNER", "ADMIN", "ANALYST"].map(source)).toEqual(["review", "review", "review"]);
        expect(source("TEAM_LEAD")).toBe("follow-ups");
        expect(["REGISTRATION_DESK", "JOB_HANDLER", "MANAGER"].map(source)).toEqual([null, null, null]);
    });

    test("landing pages", () => {
        const land = (role: string) => landingPath(userWithRole(role));
        expect([land("OWNER"), land("ADMIN"), land("ANALYST")]).toEqual([null, null, null]);
        expect([land("TEAM_LEAD"), land("REGISTRATION_DESK"), land("JOB_HANDLER")]).toEqual(["/candidates", "/candidates/new", "/jobs"]);
    });

    test("every sidebar entry names its roles explicitly (never TEAM_LEAD through ADMIN)", () => {
        const visible = (role: string) => NAV_ITEMS.filter((item) => (item.roles as readonly string[]).includes(role)).map((item) => item.label);
        expect(visible("TEAM_LEAD")).toEqual(["Candidates", "Need Attention", "Work Allocation", "Jobs", "Agents", "Client Management", "Daily Report"]);
        expect(visible("REGISTRATION_DESK")).toEqual(["Add Candidate", "Need Attention"]);
        expect(visible("JOB_HANDLER")).toEqual(["Candidates", "Jobs", "Agents", "Client Management"]);
    });
});

describe("TEAM_LEAD: the notification bell without the Review Queue", () => {
    test("the bell reads open Need Attention follow-ups; the Review Queue is never requested", { timeout: 20_000 }, async () => {
        const { calls } = backend("TEAM_LEAD");
        renderApp("/candidates");
        const bell = await screen.findByRole("button", { name: "Notifications (1 unread)" }, RENDER_STEP);
        expect(requested(calls, /^\/api\/admin\/follow-ups\?status=OPEN$/)).toBe(true);
        const user = userEvent.setup();
        await user.click(bell);
        expect(screen.getByText("Needs attention")).toBeInTheDocument();
        expect(screen.getByText("SAMAN SILVA: Medical not uploaded")).toBeInTheDocument();
        const link = screen.getByRole("link", { name: "Open Need Attention" });
        // Only ever a page the Team Lead can open.
        expect(link).toHaveAttribute("href", "/follow-ups");
        expect(screen.queryByRole("link", { name: "Review document" })).not.toBeInTheDocument();
        await user.click(link);
        expect(await screen.findByRole("heading", { name: "Need Attention", level: 1 }, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
        expect(requested(calls, /\/api\/admin\/(review|overview|users|settings|audit-logs)/)).toBe(false);
    });

    test("forbidden pages are blocked by URL, with no request for their data", { timeout: 60_000 }, async () => {
        for (const path of ["/", "/review", "/review/pending-1", "/documents", "/missing-documents", "/police", "/clients", "/settings", "/audit-logs"]) {
            const { calls } = backend("TEAM_LEAD");
            const { unmount } = renderApp(path);
            if (path === "/") {
                // The landing page is Candidates, not the Overview.
                await waitFor(() => expect(requested(calls, /^\/api\/admin\/candidates\?/)).toBe(true), RENDER_STEP);
            } else {
                expect((await screen.findAllByText(/Access Restricted|Only administrators/, {}, RENDER_STEP)).length, path).toBeGreaterThan(0);
            }
            expect(requested(calls, /\/api\/admin\/(review|overview|documents|police|clients|users|settings|audit-logs)/), path).toBe(false);
            unmount();
        }
    });
});

describe("REGISTRATION_DESK: the registration workflow and a read-only Need Attention", () => {
    test("the sidebar is Add Candidate and Need Attention; it lands on Add Candidate; no bell; the form links nowhere else", { timeout: 20_000 }, async () => {
        const { calls } = backend("REGISTRATION_DESK");
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Add candidate", level: 1 }, RENDER_STEP)).toBeInTheDocument();
        expect(navLinks()).toEqual(["Add Candidate", "Need Attention"]);
        expect(screen.queryByRole("button", { name: /^Notifications/ })).not.toBeInTheDocument();
        expect(within(screen.getByRole("main")).queryByRole("link", { name: "Candidates" })).not.toBeInTheDocument();
        expect(requested(calls, /\/api\/admin\/(candidates\?|candidates$|review|overview|follow-ups)/)).toBe(false);
    });

    test("Need Attention opens read only: the follow-ups, the candidate's name without a link to their page, no actions", { timeout: 20_000 }, async () => {
        const { calls } = backend("REGISTRATION_DESK");
        renderApp("/follow-ups");
        const card = await screen.findByRole("listitem", { name: "SAMAN SILVA" }, RENDER_STEP);
        expect(within(card).getByText("Medical not uploaded")).toBeInTheDocument();
        expect(within(card).getByText("SAMAN SILVA")).toBeInTheDocument();
        expect(within(card).queryByRole("link", { name: "SAMAN SILVA" })).not.toBeInTheDocument();
        for (const name of ["Mark complete", "Delete follow-up"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
        expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    });

    test("every other page is blocked by URL (the candidate page included), with no request for its data", { timeout: 60_000 }, async () => {
        for (const path of ["/candidates", "/candidates/N0000002", "/work-allocation", "/jobs", "/agents", "/client-management", "/settings", "/audit-logs", "/reports/daily", "/review", "/documents", "/police"]) {
            const { calls } = backend("REGISTRATION_DESK");
            const { unmount } = renderApp(path);
            expect((await screen.findAllByText(/Access Restricted|Only administrators|can't|cannot/i, {}, RENDER_STEP)).length, path).toBeGreaterThan(0);
            expect(requested(calls, /\/api\/admin\/(candidates|work-allocation|jobs|agents|client-management|settings|audit-logs|reports|review|documents|police)/), path).toBe(false);
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
        expect(screen.queryByRole("button", { name: /^Notifications/ })).not.toBeInTheDocument();
    });

    test("Need Attention and the other non-job pages stay blocked", { timeout: 60_000 }, async () => {
        for (const path of ["/follow-ups", "/candidates/new", "/work-allocation", "/reports/daily", "/review"]) {
            const { calls } = backend("JOB_HANDLER");
            const { unmount } = renderApp(path);
            expect(await screen.findByText(/Access Restricted|Candidate registration is done by/, {}, RENDER_STEP), path).toBeInTheDocument();
            expect(requested(calls, /\/api\/admin\/(follow-ups|work-allocation|reports|review)/), path).toBe(false);
            unmount();
        }
    });
});

describe("ANALYST", () => {
    test("keeps its pages; the bell stays the (server-scoped) Review Queue; no allocation, master data or Settings", { timeout: 20_000 }, async () => {
        const { calls } = backend("ANALYST", { "GET /api/admin/review": { status: 200, body: { items: [], summary: { total: 0 }, pagination: PAGE } } });
        renderApp("/candidates");
        await screen.findByRole("navigation", { name: "Main navigation" }, RENDER_STEP);
        await waitFor(() => expect(requested(calls, /^\/api\/admin\/candidates\?/)).toBe(true), RENDER_STEP);
        expect(navLinks()).toEqual(["Overview", "Candidates", "Need Attention", "Jobs", "Documents", "Missing Documents", "Review Queue", "Police Workflow", "Daily Report"]);
        await waitFor(() => expect(requested(calls, /^\/api\/admin\/review\?/)).toBe(true));
        expect(screen.getByRole("button", { name: /^Notifications/ })).toBeInTheDocument();
    });

    test("a candidate outside the allocation (the server answers 404) shows nothing of it", { timeout: 20_000 }, async () => {
        backend("ANALYST", { "GET /api/admin/candidates/N0000009": { status: 404, body: { message: "Candidate not found" } } });
        renderApp("/candidates/N0000009");
        expect(await screen.findByText("Candidate not found", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Call log" })).not.toBeInTheDocument();
    });
});
