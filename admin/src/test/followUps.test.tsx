import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { CandidateDetails, DocumentStatusEntry } from "../api/candidates";
import { CANDIDATE_STAGES } from "../api/candidates";
import type { FollowUpGroup, FollowUpItem, FollowUpList } from "../api/followUps";
import { ADMIN, RENDER_STEP, renderApp, renderAppSignedIn, signedInBackend } from "./helpers";

// Need Attention page (the Priority Follow-Ups feature). Synthetic candidates and calls only; the backend
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

describe("Need Attention page", () => {
    test("1, 4, 8, 15-16. loads candidate groups: one card per candidate, its follow-ups inside, no documents block", async () => {
        const { calls } = signedInBackend({ ...listRoute() });
        renderApp("/follow-ups");
        expect(await screen.findByRole("heading", { level: 1, name: "Need Attention" })).toBeInTheDocument();
        expect(screen.getByText("Calls and candidate follow-ups that require action.")).toBeInTheDocument();
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
        expect(within(samanRows[0]).getByRole("img", { name: "Needs attention" })).toBeInTheDocument();
        // 4. The Current Documents block is not on this page (the API still sends documentStatus).
        expect(screen.queryByRole("list", { name: "Current documents" })).toBeNull();
        expect(screen.queryByText(/of \d+ uploaded/)).toBeNull();
        expect(screen.queryByText("Current documents")).toBeNull();

        const kamal = await group("KAMAL PERERA");
        expect(within(kamal).getByText("1 follow-up")).toBeInTheDocument();
        expect(within(kamal).getByText("0112345678")).toBeInTheDocument();
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
        expect(within(dialog).getByRole("button", { name: "Mark as needs attention" })).toBeInTheDocument();
    });

    test("2-3. the sidebar says Need Attention after Candidates and opens the page; \"Priority Follow-Ups\" is shown nowhere", async () => {
        signedInBackend({ ...listRoute() });
        renderApp("/");
        const nav = within(await screen.findByRole("navigation", { name: "Main navigation" }));
        const links = nav.getAllByRole("link").map((l) => l.textContent);
        expect(links.indexOf("Need Attention")).toBe(links.indexOf("Candidates") + 1);
        expect(links).not.toContain("Priority Follow-Ups");
        const link = nav.getByRole("link", { name: "Need Attention" });
        // The route is unchanged: only the label is new.
        expect(link).toHaveAttribute("href", "/follow-ups");
        await userEvent.setup().click(link);
        expect(await screen.findByRole("heading", { level: 1, name: "Need Attention" })).toBeInTheDocument();
        await group("SAMAN SILVA");
        expect(document.body.textContent).not.toMatch(/Priority Follow-Ups?/);
    });

    test("5-9. no Need Attention text button or badge: each open follow-up has one compact flag (named, with a tooltip); Mark complete stays", async () => {
        signedInBackend({ ...asRole("ANALYST"), ...listRoute() });
        renderApp("/follow-ups");
        const saman = await group("SAMAN SILVA");
        const row = rowWith(saman, "Passport not uploaded");
        expect(within(row).queryByRole("button", { name: /need.* attention/i })).toBeNull();
        expect(within(row).queryByText(/needs? attention/i)).toBeNull();
        const flag = within(row).getByRole("img", { name: "Needs attention" });
        expect(flag).toHaveAttribute("title", "Needs attention");
        expect(flag.textContent).toBe("");
        expect(flag.querySelector("svg")).not.toBeNull();
        // At the top right of the row, beside who called, not in the actions.
        expect(flag.parentElement).toContainElement(within(row).getByText("Called by Dee Desk"));
        expect(within(row).getByRole("button", { name: "Mark complete" })).toBeInTheDocument();
        expect(within(saman).getAllByRole("img", { name: "Needs attention" })).toHaveLength(2);
    });

    test("9-10, 12. a completed follow-up shows the muted completed icon, who completed it and when, and no Mark complete; it stays in the history", async () => {
        signedInBackend({ ...listRoute() });
        renderApp("/follow-ups");
        await group("SAMAN SILVA");
        await userEvent.setup().click(screen.getByRole("button", { name: "Completed" }));
        const kamal = await group("KAMAL PERERA");
        const row = rowWith(kamal, "Scan was missing");
        const icon = within(row).getByRole("img", { name: "Follow-up completed" });
        expect(icon).toHaveAttribute("title", "Follow-up completed");
        expect(icon.className).toContain("text-ink-subtle");
        expect(icon.className).not.toContain("text-review");
        // The state is not carried by colour alone: another icon shape and another name.
        expect(within(row).queryByRole("img", { name: "Needs attention" })).toBeNull();
        expect(within(row).getByText(/Completed .* by Max Manager/)).toBeInTheDocument();
        expect(within(row).queryByRole("button", { name: "Mark complete" })).toBeNull();
        expect(within(row).queryByText(/needs? attention/i)).toBeNull();
        // 4. Resolved reads as quieter: a soft neutral wash, a muted note; an open row has neither.
        expect(row).toHaveAttribute("data-state", "completed");
        expect(row.className).toContain("bg-canvas/50");
        expect(within(row).getByText("Scan was missing").className).toContain("text-ink-muted");
    });

    test("5. an open follow-up is not washed out, and its flag is amber", async () => {
        signedInBackend({ ...listRoute() });
        renderApp("/follow-ups");
        const row = rowWith(await group("SAMAN SILVA"), "Passport not uploaded");
        expect(row).toHaveAttribute("data-state", "open");
        expect(row.className).not.toContain("bg-canvas");
        expect(within(row).getByText("Passport not uploaded").className).toContain("text-ink-soft");
        expect(within(row).getByRole("img", { name: "Needs attention" }).className).toContain("text-review");
    });

    test("a flagged No Answer call reads as No Answer, not as an empty row", async () => {
        const noAnswer = item("f-5", "", { callLog: { callLogId: "call-f-5", note: "", outcome: "NO_ANSWER", calledAt: "2026-10-13T04:06:00.000Z", adminName: "Dee Desk" } });
        signedInBackend({ ...listRoute({ OPEN: { status: "OPEN", total: 1, truncated: false, groups: [{ ...SAMAN, followUps: [noAnswer] }] } }) });
        renderApp("/follow-ups");
        const row = within(within(await group("SAMAN SILVA")).getByRole("list", { name: /^Follow-ups for/ })).getByRole("listitem");
        // The same badge as in Candidate History: red icon and outline, normal text colour.
        const badge = within(row).getByText("No Answer");
        expect(badge).toHaveAttribute("data-outcome", "NO_ANSWER");
        expect(badge.className).toContain("border-critical-border");
        expect(badge.className).toContain("text-ink-soft");
        expect(badge.querySelector(".text-critical")).not.toBeNull();
        expect(within(row).getByRole("img", { name: "Needs attention" })).toBeInTheDocument();
    });

    test("18-19. long call notes wrap inside the card; the row, flag and actions are laid out to wrap without overlap", async () => {
        const long = "x".repeat(400);
        signedInBackend({ ...asRole("MANAGER"), ...listRoute({ OPEN: { status: "OPEN", total: 1, truncated: false, groups: [{ ...SAMAN, followUps: [item("f-7", long)] }] } }) });
        renderApp("/follow-ups");
        const row = within(within(await group("SAMAN SILVA")).getByRole("list", { name: /^Follow-ups for/ })).getByRole("listitem");
        // jsdom has no layout: check the wrapping rules are applied.
        const note = within(row).getByText(long);
        for (const rule of ["whitespace-pre-wrap", "break-words", "[overflow-wrap:anywhere]"]) expect(note.className).toContain(rule);
        // Metadata and actions wrap onto a second line instead of overflowing; the flag never shrinks.
        const actions = within(row).getByRole("button", { name: "Mark complete" }).parentElement!;
        expect(actions.parentElement!.className).toContain("flex-wrap");
        expect(actions.className).toContain("shrink-0");
        expect(within(row).getByRole("img", { name: "Needs attention" }).className).toContain("shrink-0");
        // Both actions are present for a MANAGER.
        expect(within(actions).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Mark complete", "Delete follow-up"]);
    });

    test("an empty list uses the new wording", async () => {
        signedInBackend({ ...listRoute({}) });
        renderApp("/follow-ups");
        expect(await screen.findByText("No open follow-ups.")).toBeInTheDocument();
        expect(screen.getByText("Calls flagged as needing attention in a candidate's history appear here.")).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/Priority Follow-Ups?/);
    });

    test("the delete confirmation names Need Attention and still says the call log, candidate and documents are kept", async () => {
        signedInBackend({ ...asRole("ADMIN"), ...listRoute() });
        renderApp("/follow-ups");
        await userEvent.setup().click(within(rowWith(await group("SAMAN SILVA"), "Passport not uploaded")).getByRole("button", { name: "Delete follow-up" }));
        const dialog = await screen.findByRole("dialog", { name: "Delete this follow-up?" });
        expect(dialog).toHaveTextContent("The follow-up is removed from Need Attention permanently. The original call log, the candidate and their documents are kept.");
    });
});
