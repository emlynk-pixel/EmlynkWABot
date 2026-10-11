import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { CandidateDetails, DocumentStatusEntry } from "../api/candidates";
import { CANDIDATE_STAGES } from "../api/candidates";
import type { FollowUpGroup, FollowUpItem, FollowUpList } from "../api/followUps";
import { ADMIN, RENDER_STEP, renderApp, renderAppSignedIn, signedInBackend } from "./helpers";

// Priority Follow-Ups page. Synthetic candidates and calls only; the backend
// is a stub (the API's own rules are in test/callLogFollowUps.test.js).

const asRole = (role: string) => ({ "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } } });

const documents = (uploaded: string[]): DocumentStatusEntry[] =>
    (["PASSPORT", "MEDICAL", "SCAN"] as const).map((documentType) => ({
        documentType,
        variant: null,
        uploaded: uploaded.includes(documentType),
        verificationStatus: uploaded.includes(documentType) ? "VERIFIED" : null,
        receivedDate: uploaded.includes(documentType) ? "2026-10-05T05:00:00.000Z" : null,
    }));

const item = (followUpId: string, note: string, overrides: Partial<FollowUpItem> = {}): FollowUpItem => ({
    followUpId,
    status: "OPEN",
    flaggedAt: "2026-10-07T05:00:00.000Z",
    flaggedByName: "Ann Analyst",
    completedAt: null,
    completedByName: null,
    callLog: { callLogId: `call-${followUpId}`, note, calledAt: "2026-10-01T11:15:00.000Z", adminName: "Dee Desk" },
    ...overrides,
});

const SAMAN: FollowUpGroup = {
    candidate: { passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", whatsappNumber: "94770000002", contactNumber: null },
    documentStatus: documents(["PASSPORT"]),
    followUps: [item("f-2", "Medical not uploaded yet"), item("f-1", "Passport not uploaded")],
};
const KAMAL: FollowUpGroup = {
    candidate: { passportId: "N0000001", uniqueId: "0001", name: "KAMAL PERERA", whatsappNumber: null, contactNumber: "0112345678" },
    documentStatus: documents(["PASSPORT", "MEDICAL", "SCAN"]),
    followUps: [item("f-3", "Police report pending")],
};
const OPEN_LIST: FollowUpList = { status: "OPEN", total: 3, truncated: false, groups: [SAMAN, KAMAL] };
const COMPLETED_LIST: FollowUpList = {
    status: "COMPLETED",
    total: 1,
    truncated: false,
    groups: [{ ...KAMAL, followUps: [item("f-9", "Scan was missing", { status: "COMPLETED", completedAt: "2026-10-08T05:00:00.000Z", completedByName: "Max Manager" })] }],
};

const listRoute = (lists: Partial<Record<string, FollowUpList>> = { OPEN: OPEN_LIST, COMPLETED: COMPLETED_LIST }) => ({
    "GET /api/admin/follow-ups": (url: URL) => ({ status: 200, body: lists[url.searchParams.get("status") ?? "OPEN"] ?? { status: "OPEN", total: 0, truncated: false, groups: [] } }),
});

const group = (name: string) => screen.findByRole("listitem", { name });
const rowWith = (container: HTMLElement, note: string) =>
    within(within(container).getByRole("list", { name: /^Follow-ups for/ })).getAllByRole("listitem").find((li) => li.textContent?.includes(note))!;

describe("Priority Follow-Ups page", () => {
    test("8, 12-15. loads candidate groups: one card per candidate, its follow-ups inside, its current documents", async () => {
        const { calls } = signedInBackend({ ...listRoute() });
        renderApp("/follow-ups");
        expect(await screen.findByRole("heading", { level: 1, name: "Priority Follow-Ups" })).toBeInTheDocument();
        expect(calls.some((c) => c.path === "/api/admin/follow-ups?status=OPEN")).toBe(true);

        const candidates = await screen.findByRole("list", { name: "Candidates" });
        expect(within(candidates).getAllByRole("listitem", { name: /SILVA|PERERA/ })).toHaveLength(2);

        const saman = await group("SAMAN SILVA");
        expect(within(saman).getAllByRole("heading", { name: "SAMAN SILVA" })).toHaveLength(1);
        expect(within(saman).getByText("N0000002")).toBeInTheDocument();
        expect(within(saman).getByText("94770000002")).toBeInTheDocument();
        expect(within(saman).getByText("2 follow-ups")).toBeInTheDocument();
        const samanRows = within(within(saman).getByRole("list", { name: "Follow-ups for SAMAN SILVA" })).getAllByRole("listitem");
        expect(samanRows.map((row) => within(row).getByText(/not uploaded/).textContent)).toEqual(["Medical not uploaded yet", "Passport not uploaded"]);
        expect(within(samanRows[0]).getByText("Called by Dee Desk")).toBeInTheDocument();
        expect(within(samanRows[0]).getByText(/Flagged .* by Ann Analyst/)).toBeInTheDocument();
        expect(within(samanRows[0]).getByText("Needs attention")).toBeInTheDocument();

        const samanDocs = within(saman).getByRole("list", { name: "Current documents" });
        expect(within(samanDocs).getByRole("listitem", { name: "Passport: uploaded" })).toHaveAttribute("data-uploaded", "true");
        expect(within(samanDocs).getByRole("listitem", { name: "Medical: not uploaded" })).toHaveAttribute("data-uploaded", "false");

        const kamal = await group("KAMAL PERERA");
        expect(within(kamal).getByText("1 follow-up")).toBeInTheDocument();
        expect(within(kamal).getByText("0112345678")).toBeInTheDocument();
        expect(within(within(kamal).getByRole("list", { name: "Current documents" })).getByRole("listitem", { name: "Medical: uploaded" })).toBeInTheDocument();
        expect(within(kamal).queryByText("Passport not uploaded")).toBeNull();
        expect(screen.getByText("3 follow-ups · 2 candidates")).toBeInTheDocument();
    });

    test("9. loading state while the list loads", async () => {
        signedInBackend({ "GET /api/admin/follow-ups": () => new Promise(() => {}) });
        await renderAppSignedIn("/follow-ups");
        expect(await screen.findByText("Loading follow-ups…", {}, RENDER_STEP)).toBeInTheDocument();
    });

    test("10. empty state", async () => {
        signedInBackend({ ...listRoute({}) });
        renderApp("/follow-ups");
        expect(await screen.findByText("No open follow-ups.")).toBeInTheDocument();
    });

    test("11. error state with a retry", async () => {
        let attempt = 0;
        signedInBackend({
            "GET /api/admin/follow-ups": () => (++attempt === 1 ? { status: 500, body: { message: "The follow-ups could not be loaded." } } : { status: 200, body: OPEN_LIST }),
        });
        renderApp("/follow-ups");
        // A 5xx shows the generic message (api/client.ts), not the server text.
        expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
        expect(await group("SAMAN SILVA")).toBeInTheDocument();
    });

    test("16-17. Mark complete: the follow-up leaves the open view; the last one takes its candidate card with it", async () => {
        const { calls } = signedInBackend({
            ...asRole("REGISTRATION_DESK"),
            ...listRoute(),
            "POST /api/admin/follow-ups/f-3/complete": { status: 200, body: { followUp: item("f-3", "Police report pending", { status: "COMPLETED" }) } },
            "POST /api/admin/follow-ups/f-1/complete": { status: 200, body: { followUp: item("f-1", "Passport not uploaded", { status: "COMPLETED" }) } },
        });
        renderApp("/follow-ups");
        const user = userEvent.setup();
        await user.click(within(rowWith(await group("SAMAN SILVA"), "Passport not uploaded")).getByRole("button", { name: "Mark complete" }));
        expect(await screen.findByRole("status")).toHaveTextContent("Follow-up marked complete. The call stays in the candidate's call log.");
        const saman = await group("SAMAN SILVA");
        expect(within(saman).queryByText("Passport not uploaded")).toBeNull();
        expect(within(saman).getByText("Medical not uploaded yet")).toBeInTheDocument();
        expect(within(saman).getByText("1 follow-up")).toBeInTheDocument();

        await user.click(within(rowWith(await group("KAMAL PERERA"), "Police report pending")).getByRole("button", { name: "Mark complete" }));
        expect(await screen.findByRole("status")).toBeInTheDocument();
        expect(screen.queryByRole("listitem", { name: "KAMAL PERERA" })).toBeNull();
        expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/admin/follow-ups/f-1/complete", "/api/admin/follow-ups/f-3/complete"]);
    });

    test("Completed shows the history with who completed it; no Mark complete", async () => {
        const { calls } = signedInBackend({ ...listRoute() });
        renderApp("/follow-ups");
        await group("SAMAN SILVA");
        await userEvent.setup().click(screen.getByRole("button", { name: "Completed" }));
        const kamal = await group("KAMAL PERERA");
        expect(within(kamal).getByText("Scan was missing")).toBeInTheDocument();
        expect(within(kamal).getByText(/Completed .* by Max Manager/)).toBeInTheDocument();
        expect(within(kamal).queryByRole("button", { name: "Mark complete" })).toBeNull();
        expect(screen.getByRole("button", { name: "Completed" })).toHaveAttribute("aria-pressed", "true");
        expect(calls.some((c) => c.path === "/api/admin/follow-ups?status=COMPLETED")).toBe(true);
    });

    for (const role of ["ADMIN", "MANAGER"]) {
        test(`18-19. ${role} sees Delete`, async () => {
            signedInBackend({ ...asRole(role), ...listRoute() });
            renderApp("/follow-ups");
            expect(within(await group("SAMAN SILVA")).getAllByRole("button", { name: "Delete follow-up" })).toHaveLength(2);
        });
    }

    for (const role of ["ANALYST", "REGISTRATION_DESK"]) {
        test(`20-21. ${role} does not see Delete, but can mark complete`, async () => {
            signedInBackend({ ...asRole(role), ...listRoute() });
            renderApp("/follow-ups");
            const saman = await group("SAMAN SILVA");
            expect(within(saman).queryByRole("button", { name: "Delete follow-up" })).toBeNull();
            expect(within(saman).getAllByRole("button", { name: "Mark complete" })).toHaveLength(2);
        });
    }

    test("22-23. Delete asks first; Cancel keeps it; confirming removes the follow-up only", async () => {
        const { calls } = signedInBackend({
            ...asRole("MANAGER"),
            ...listRoute(),
            "DELETE /api/admin/follow-ups/f-1": { status: 200, body: { deleted: true, followUpId: "f-1" } },
        });
        renderApp("/follow-ups");
        const user = userEvent.setup();
        await user.click(within(rowWith(await group("SAMAN SILVA"), "Passport not uploaded")).getByRole("button", { name: "Delete follow-up" }));
        let dialog = await screen.findByRole("dialog", { name: "Delete this follow-up?" });
        expect(dialog).toHaveTextContent("The original call log, the candidate and their documents are kept.");
        expect(within(dialog).getByText("Passport not uploaded")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(calls.some((c) => c.method === "DELETE")).toBe(false);
        expect(within(await group("SAMAN SILVA")).getByText("Passport not uploaded")).toBeInTheDocument();

        await user.click(within(rowWith(await group("SAMAN SILVA"), "Passport not uploaded")).getByRole("button", { name: "Delete follow-up" }));
        dialog = await screen.findByRole("dialog", { name: "Delete this follow-up?" });
        await user.click(within(dialog).getByRole("button", { name: "Delete follow-up" }));
        expect(await screen.findByRole("status")).toHaveTextContent("Follow-up deleted. The original call log is kept.");
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(within(await group("SAMAN SILVA")).queryByText("Passport not uploaded")).toBeNull();
        expect(within(await group("SAMAN SILVA")).getByText("Medical not uploaded yet")).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/api/admin/follow-ups/f-1"]);
    });

    test("a refused delete (403) keeps the follow-up and says why", async () => {
        signedInBackend({ ...listRoute(), "DELETE /api/admin/follow-ups/f-1": { status: 403, body: { message: "Insufficient permissions" } } });
        renderApp("/follow-ups");
        const user = userEvent.setup();
        await user.click(within(rowWith(await group("SAMAN SILVA"), "Passport not uploaded")).getByRole("button", { name: "Delete follow-up" }));
        const dialog = await screen.findByRole("dialog", { name: "Delete this follow-up?" });
        await user.click(within(dialog).getByRole("button", { name: "Delete follow-up" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("Insufficient permissions");
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(within(await group("SAMAN SILVA")).getByText("Passport not uploaded")).toBeInTheDocument();
    });

    test("24, 27. after a delete the original call is still in the candidate's call log; the candidate page still works", async () => {
        const stages = CANDIDATE_STAGES.map((stage) => ({ stage, completed: false, completedAt: null, notes: null, jobId: null, testResult: null, testDate: null, automatic: false, missing: [] }));
        const details: CandidateDetails = {
            candidate: {
                passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: null, jobTypes: [], surname: "SILVA", otherNames: "SAMAN",
                dateOfBirth: null, placeOfBirth: null, passportExpiryDate: null, passportIssueDate: null, nationality: null, sex: null,
                address: null, jobExperience: null, whatsappNumber: "94770000002", contactNumber: null,
            },
            stages,
            documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null, VISA_SUBMISSION: null },
            variantDocuments: { POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null } },
            requiredDocuments: [],
        };
        signedInBackend({
            ...listRoute(),
            "DELETE /api/admin/follow-ups/f-1": { status: 200, body: { deleted: true, followUpId: "f-1" } },
            "GET /api/admin/candidates/N0000002": { status: 200, body: details },
            "GET /api/admin/candidates/N0000002/call-logs": {
                status: 200,
                body: { items: [{ callLogId: "call-f-1", note: "Passport not uploaded", calledAt: "2026-10-01T11:15:00.000Z", adminName: "Dee Desk", followUp: null }], documentStatus: documents(["PASSPORT"]) },
            },
        });
        renderApp("/follow-ups");
        const user = userEvent.setup();
        await user.click(within(rowWith(await group("SAMAN SILVA"), "Passport not uploaded")).getByRole("button", { name: "Delete follow-up" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Delete this follow-up?" })).getByRole("button", { name: "Delete follow-up" }));
        await screen.findByRole("status");

        await user.click(within(await group("SAMAN SILVA")).getByRole("link", { name: "SAMAN SILVA" }));
        expect(await screen.findByRole("heading", { level: 1, name: "SAMAN SILVA" })).toBeInTheDocument();
        await user.click(await screen.findByRole("button", { name: "Call log" }));
        const dialog = await screen.findByRole("dialog", { name: "Call Logs" });
        expect(await within(dialog).findByText("Passport not uploaded")).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Need attention" })).toBeInTheDocument();
    });

    test("28. the sidebar has Priority Follow-Ups after Candidates and it opens the page", async () => {
        signedInBackend({ ...listRoute() });
        renderApp("/");
        const nav = within(await screen.findByRole("navigation", { name: "Main navigation" }));
        const links = nav.getAllByRole("link").map((l) => l.textContent);
        expect(links.indexOf("Priority Follow-Ups")).toBe(links.indexOf("Candidates") + 1);
        await userEvent.setup().click(nav.getByRole("link", { name: "Priority Follow-Ups" }));
        expect(await screen.findByRole("heading", { level: 1, name: "Priority Follow-Ups" })).toBeInTheDocument();
    });
});
