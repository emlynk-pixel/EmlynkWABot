import { describe, expect, test } from "vitest";
import type { AdminNotification } from "../api/notifications";
import { NOTIFICATION_TARGETS, notificationTarget } from "../notifications/targets";

// Every type the server sends (src/services/notificationEvents.js NOTIFICATION_TYPE).
const SERVER_TYPES = [
    "A1_NEW_CANDIDATES_ALLOCATED", "A4_CANDIDATE_FORM_SUBMITTED", "A5_JOB_ASSIGNED", "B2_ROLE_UPDATED", "C1_NEW_JOB_ADDED",
    "C2_MISSING_COUNTRY_INFORMATION", "E1_CANDIDATE_CANCELLED", "E2_CANDIDATE_NEED_ATTENTION", "E9_GOOGLE_SHEET_SYNC_FAILED",
    "E10_CANDIDATE_FORM_LINK_FAILED", "F1_GOOGLE_SHEET_SYNC_ERROR", "F2_SYSTEM_ALERT", "A2_PENDING_FOLLOW_UPS",
    "A3_PASSWORD_CHANGE_REMINDER", "B1_MONTHLY_REGISTRATION_SUMMARY", "C3_PASSWORD_CHANGE_REMINDER", "D1_UNALLOCATED_CANDIDATES",
    "D2_DAILY_REPORT_UPDATED", "D3_NEW_VACANCIES_AVAILABLE", "D4_PASSWORD_CHANGE_REMINDER", "E3_NEW_CANDIDATES_ADDED",
    "E4_MISSING_DOCUMENTS_OR_INFORMATION", "E5_NEED_ATTENTION_FOLLOW_UPS_PENDING", "E6_JOBS_STUCK_IN_PROCESSING",
    "E7_DOCUMENTS_AWAITING_REVIEW", "E8_STAFF_INACTIVITY",
];
const NO_PAGE = ["A3_PASSWORD_CHANGE_REMINDER", "B2_ROLE_UPDATED", "C3_PASSWORD_CHANGE_REMINDER", "D4_PASSWORD_CHANGE_REMINDER", "E10_CANDIDATE_FORM_LINK_FAILED", "F2_SYSTEM_ALERT"];

// The app's routes (App.tsx) a notification may open.
const ROUTE = /^\/(candidates|candidates\/new|candidates\/[^/]+|follow-ups|work-allocation|reports\/daily|jobs|jobs\/[^/]+|agents|missing-documents|review|settings\/sheet-sync)$/;

const item = (type: string, ids: Partial<Pick<AdminNotification, "candidateId" | "jobId">> = {}): AdminNotification => ({
    id: "n1", type, title: "T", message: "M", createdAt: "2026-09-25T01:00:00Z", readAt: null, ...ids,
});
const as = (role: string) => ({ role });
const to = (type: string, role: string, ids: Partial<Pick<AdminNotification, "candidateId" | "jobId">> = {}) => notificationTarget(item(type, ids), as(role));

describe("notification targets", () => {
    test("every server type has an entry: a page for ADMIN on a real route, or an explicit null", () => {
        expect(Object.keys(NOTIFICATION_TARGETS).sort()).toEqual([...SERVER_TYPES].sort());
        for (const type of SERVER_TYPES) {
            if (NO_PAGE.includes(type)) {
                expect(NOTIFICATION_TARGETS[type], type).toBeNull();
                expect(to(type, "ADMIN"), type).toEqual({ kind: "none" });
                continue;
            }
            // B1 goes to the Registration Desk, which opens Add Candidate.
            const target = to(type, type.startsWith("B1") ? "REGISTRATION_DESK" : "ADMIN", { candidateId: "N1234567", jobId: "job-1" });
            expect(target.kind, type).toBe("open");
            if (target.kind === "open") expect(target.to, type).toMatch(ROUTE);
        }
    });

    test("the agreed pages, by type", () => {
        const page = (type: string, role = "ADMIN", ids = {}) => {
            const target = to(type, role, ids);
            return target.kind === "open" ? target.to : target.kind;
        };
        for (const type of ["A1_NEW_CANDIDATES_ALLOCATED", "A4_CANDIDATE_FORM_SUBMITTED", "A5_JOB_ASSIGNED"]) expect(page(type, "ANALYST", { candidateId: "N1234567" })).toBe("/candidates/N1234567");
        expect(page("E1_CANDIDATE_CANCELLED", "TEAM_LEAD", { candidateId: "N1234567" })).toBe("/candidates/N1234567");
        for (const type of ["A2_PENDING_FOLLOW_UPS", "E2_CANDIDATE_NEED_ATTENTION", "E5_NEED_ATTENTION_FOLLOW_UPS_PENDING"]) expect(page(type)).toBe("/follow-ups");
        expect(page("D1_UNALLOCATED_CANDIDATES", "TEAM_LEAD")).toBe("/work-allocation");
        expect(page("D2_DAILY_REPORT_UPDATED", "TEAM_LEAD")).toBe("/reports/daily");
        expect(page("E8_STAFF_INACTIVITY")).toBe("/reports/daily");
        expect(page("C1_NEW_JOB_ADDED", "JOB_HANDLER", { jobId: "job-1" })).toBe("/jobs/job-1");
        expect(page("D3_NEW_VACANCIES_AVAILABLE", "TEAM_LEAD", { jobId: "job-2" })).toBe("/jobs/job-2");
        expect(page("E6_JOBS_STUCK_IN_PROCESSING")).toBe("/jobs");
        expect(page("C2_MISSING_COUNTRY_INFORMATION", "JOB_HANDLER")).toBe("/agents");
        expect(page("E4_MISSING_DOCUMENTS_OR_INFORMATION")).toBe("/missing-documents");
        expect(page("E7_DOCUMENTS_AWAITING_REVIEW")).toBe("/review");
        expect(page("E3_NEW_CANDIDATES_ADDED")).toBe("/candidates");
        expect(page("E9_GOOGLE_SHEET_SYNC_FAILED")).toBe("/settings/sheet-sync");
        expect(page("F1_GOOGLE_SHEET_SYNC_ERROR", "OWNER")).toBe("/settings/sheet-sync");
        expect(page("F2_SYSTEM_ALERT", "OWNER")).toBe("none");
        expect(page("E10_CANDIDATE_FORM_LINK_FAILED")).toBe("none");
    });

    test("ids are encoded into the path", () => {
        expect(to("A4_CANDIDATE_FORM_SUBMITTED", "ADMIN", { candidateId: "N 12/3" })).toEqual({ kind: "open", to: "/candidates/N%2012%2F3", record: true });
    });

    test("without an id (null, empty or missing) the section page opens", () => {
        for (const ids of [{}, { candidateId: null }, { candidateId: "" }]) {
            expect(to("A1_NEW_CANDIDATES_ALLOCATED", "ANALYST", ids)).toEqual({ kind: "open", to: "/candidates", record: false });
        }
        for (const ids of [{}, { jobId: null }]) expect(to("C1_NEW_JOB_ADDED", "JOB_HANDLER", ids)).toEqual({ kind: "open", to: "/jobs", record: false });
    });

    test("a role that cannot open the page falls back to a permitted section, or is denied", () => {
        // Missing Documents and Review are ADMIN only: a Team Lead gets the Candidates list.
        expect(to("E4_MISSING_DOCUMENTS_OR_INFORMATION", "TEAM_LEAD")).toEqual({ kind: "open", to: "/candidates", record: false });
        expect(to("E7_DOCUMENTS_AWAITING_REVIEW", "TEAM_LEAD")).toEqual({ kind: "open", to: "/candidates", record: false });
        // Settings is ADMIN only: a Team Lead (E9) has no page to go to; E10 has no page for anyone.
        expect(to("E9_GOOGLE_SHEET_SYNC_FAILED", "TEAM_LEAD")).toEqual({ kind: "denied" });
        expect(to("E10_CANDIDATE_FORM_LINK_FAILED", "TEAM_LEAD")).toEqual({ kind: "none" });
        // A Registration Desk user cannot open a candidate's page or the list.
        expect(to("A1_NEW_CANDIDATES_ALLOCATED", "REGISTRATION_DESK", { candidateId: "N1234567" })).toEqual({ kind: "denied" });
        expect(to("B1_MONTHLY_REGISTRATION_SUMMARY", "REGISTRATION_DESK")).toEqual({ kind: "open", to: "/candidates/new", record: false });
        expect(to("C1_NEW_JOB_ADDED", "ANALYST", { jobId: "job-1" })).toEqual({ kind: "denied" });
        expect(notificationTarget(item("E3_NEW_CANDIDATES_ADDED"), null)).toEqual({ kind: "denied" });
    });

    test("an OWNER opens every ADMIN page (hasRole inheritance)", () => {
        expect(to("E4_MISSING_DOCUMENTS_OR_INFORMATION", "OWNER")).toEqual({ kind: "open", to: "/missing-documents", record: false });
        expect(to("E7_DOCUMENTS_AWAITING_REVIEW", "OWNER")).toEqual({ kind: "open", to: "/review", record: false });
        expect(to("E9_GOOGLE_SHEET_SYNC_FAILED", "OWNER")).toEqual({ kind: "open", to: "/settings/sheet-sync", record: false });
        expect(to("E1_CANDIDATE_CANCELLED", "OWNER", { candidateId: "N1" })).toEqual({ kind: "open", to: "/candidates/N1", record: true });
    });

    test("an unknown or inherited-property type opens nothing", () => {
        expect(to("Z9_SOMETHING_NEW", "ADMIN")).toEqual({ kind: "none" });
        expect(to("toString", "ADMIN")).toEqual({ kind: "none" });
    });
});
