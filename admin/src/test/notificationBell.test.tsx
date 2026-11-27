import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as authProvider from "../auth/AuthProvider";
import { NotificationBell } from "../components/NotificationBell";
import * as api from "../api/notifications";
import { NO_ACCESS_MESSAGE, RECORD_GONE } from "../notifications/targets";
import { fakeAuth, renderApp, RENDER_STEP, SESSION_TOKEN, stubBackend, userWithRole } from "./helpers";

vi.mock("../api/notifications", () => ({
    listNotifications: vi.fn(),
    getUnreadCount: vi.fn(),
    markNotificationRead: vi.fn(),
}));

const MOCK_USER = { userId: "user-1", email: "test@example.com", name: "Test Admin", role: "ADMIN", status: "ACTIVE" };

const note = (id: string, readAt: string | null = null, extra: Partial<api.AdminNotification> = {}): api.AdminNotification => ({
    id, type: "GENERIC", title: `Title ${id}`, message: `Message ${id}`, createdAt: "2026-09-25T01:00:00Z", readAt, ...extra,
});

// Where the router is now (and the state the click left), shown for the assertions.
function Where() {
    const location = useLocation();
    return <div data-testid="where" data-state={JSON.stringify(location.state ?? null)}>{location.pathname}</div>;
}

const list = vi.mocked(api.listNotifications);
const count = vi.mocked(api.getUnreadCount);
const markRead = vi.mocked(api.markNotificationRead);

function renderBell(role = "ADMIN") {
    vi.spyOn(authProvider, "useAuth").mockReturnValue({
        user: { ...MOCK_USER, role } as any,
        token: "fake-token",
        status: "authenticated",
        notice: null,
        signIn: vi.fn(),
        signOut: vi.fn(),
        refreshUser: vi.fn(),
    });
    return render(
        <MemoryRouter initialEntries={["/start"]}>
            <NotificationBell />
            <Where />
        </MemoryRouter>,
    );
}
const where = () => screen.getByTestId("where");

describe("NotificationBell", () => {
    const user = userEvent.setup();

    beforeEach(() => {
        vi.clearAllMocks();
        count.mockResolvedValue({ unreadCount: 0 });
        list.mockResolvedValue({ items: [], unreadCount: 0, nextCursor: null });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("no badge at zero unread and empty state shown for every role", async () => {
        for (const role of ["REGISTRATION_DESK", "JOB_HANDLER"]) {
            const { unmount } = renderBell(role);
            const button = screen.getByRole("button", { name: "Notifications" });
            await waitFor(() => expect(count).toHaveBeenCalled());
            expect(screen.queryByText("0")).not.toBeInTheDocument();
            await user.click(button);
            expect(await screen.findByText("You have no notifications.")).toBeInTheDocument();
            unmount();
        }
    });

    test("badge shows the unread count with an accessible label, capped at 99+", async () => {
        count.mockResolvedValue({ unreadCount: 3 });
        const { unmount } = renderBell();
        expect(await screen.findByRole("button", { name: "Notifications (3 unread)" })).toBeInTheDocument();
        expect(screen.getByText("3")).toBeInTheDocument();
        unmount();

        count.mockResolvedValue({ unreadCount: 150 });
        renderBell();
        expect(await screen.findByText("99+")).toBeInTheDocument();
    });

    test("unread rows are highlighted and read rows are not; times use Asia/Colombo", async () => {
        count.mockResolvedValue({ unreadCount: 1 });
        list.mockResolvedValue({ items: [note("a"), note("b", "2026-09-25T02:00:00Z")], unreadCount: 1, nextCursor: null });
        renderBell();
        await user.click(await screen.findByRole("button", { name: /Notifications/ }));

        expect(await screen.findByText("Title a")).toBeInTheDocument();
        expect(screen.getByText("Title a").closest("li")).toHaveAttribute("data-unread", "true");
        expect(screen.getByText("Title a").closest("li")).toHaveClass("bg-primary-soft");
        expect(screen.getByText("Title b").closest("li")).toHaveAttribute("data-unread", "false");
        expect(screen.getByText("Title b").closest("li")).not.toHaveClass("bg-primary-soft");
        expect(screen.getAllByText("25 Sept 2026, 06:30").length).toBe(2);
        expect(screen.getByText("Message a")).toBeInTheDocument();
    });

    test("clicking a notification marks it read and decrements the count", async () => {
        count.mockResolvedValue({ unreadCount: 2 });
        list.mockResolvedValue({ items: [note("a"), note("b")], unreadCount: 2, nextCursor: null });
        markRead.mockResolvedValue({ id: "a", readAt: "2026-09-25T03:00:00Z", unreadCount: 1 });
        renderBell();
        await user.click(await screen.findByRole("button", { name: "Notifications (2 unread)" }));

        await user.click(await screen.findByRole("button", { name: /Title a/ }));

        expect(markRead).toHaveBeenCalledWith("fake-token", "a");
        await waitFor(() => expect(screen.getByText("Title a").closest("li")).toHaveAttribute("data-unread", "false"));
        expect(screen.getByRole("button", { name: "Notifications (1 unread)" })).toBeInTheDocument();
    });

    test("a failed mark-read rolls back", async () => {
        count.mockResolvedValue({ unreadCount: 1 });
        list.mockResolvedValue({ items: [note("a")], unreadCount: 1, nextCursor: null });
        markRead.mockRejectedValue(new Error("nope"));
        renderBell();
        await user.click(await screen.findByRole("button", { name: "Notifications (1 unread)" }));
        await user.click(await screen.findByRole("button", { name: /Title a/ }));

        await waitFor(() => expect(screen.getByText("Title a").closest("li")).toHaveAttribute("data-unread", "true"));
        expect(screen.getByRole("button", { name: "Notifications (1 unread)" })).toBeInTheDocument();
    });

    test("Load more appends the next page using nextCursor", async () => {
        count.mockResolvedValue({ unreadCount: 2 });
        list.mockResolvedValueOnce({ items: [note("a")], unreadCount: 2, nextCursor: "c1" });
        list.mockResolvedValueOnce({ items: [note("b")], unreadCount: 2, nextCursor: null });
        renderBell();
        await user.click(await screen.findByRole("button", { name: /Notifications/ }));
        await user.click(await screen.findByRole("button", { name: "Load more" }));

        expect(await screen.findByText("Title b")).toBeInTheDocument();
        expect(list).toHaveBeenLastCalledWith("fake-token", { limit: 30, cursor: "c1" });
        expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    });

    test("shows an error state when the list fails", async () => {
        list.mockRejectedValue(new Error("API Error"));
        renderBell();
        await user.click(screen.getByRole("button", { name: /Notifications/ }));
        expect(await screen.findByText("Could not load notifications. Please try again.")).toBeInTheDocument();
    });

    test("polls the unread count every 30s, not while hidden, and refetches on visibility return", async () => {
        vi.useFakeTimers();
        count.mockResolvedValue({ unreadCount: 0 });
        renderBell();
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(count).toHaveBeenCalledTimes(1);

        count.mockResolvedValue({ unreadCount: 4 });
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(count).toHaveBeenCalledTimes(2);
        expect(screen.getByRole("button", { name: "Notifications (4 unread)" })).toBeInTheDocument();

        const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(count).toHaveBeenCalledTimes(2);

        hidden.mockReturnValue(false);
        count.mockResolvedValue({ unreadCount: 5 });
        await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
        expect(count).toHaveBeenCalledTimes(3);
        expect(screen.getByRole("button", { name: "Notifications (5 unread)" })).toBeInTheDocument();
    });

    test("when the count rises while the panel is open, the list refreshes", async () => {
        vi.useFakeTimers();
        count.mockResolvedValue({ unreadCount: 1 });
        list.mockResolvedValue({ items: [note("a")], unreadCount: 1, nextCursor: null });
        renderBell();
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        await act(async () => { screen.getByRole("button", { name: /Notifications/ }).click(); await vi.advanceTimersByTimeAsync(0); });
        expect(screen.getByText("Title a")).toBeInTheDocument();
        const listCalls = list.mock.calls.length;

        count.mockResolvedValue({ unreadCount: 2 });
        list.mockResolvedValue({ items: [note("new"), note("a")], unreadCount: 2, nextCursor: null });
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

        expect(list.mock.calls.length).toBe(listCalls + 1);
        expect(screen.getByText("Title new")).toBeInTheDocument();
    });
});

describe("NotificationBell: opening a notification", () => {
    const user = userEvent.setup();

    beforeEach(() => {
        vi.clearAllMocks();
        count.mockResolvedValue({ unreadCount: 1 });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const openPanel = async () => user.click(await screen.findByRole("button", { name: /Notifications/ }));

    test("a click marks it read, opens the candidate's page and closes the panel", async () => {
        list.mockResolvedValue({ items: [note("a", null, { type: "A4_CANDIDATE_FORM_SUBMITTED", candidateId: "N1234567" })], unreadCount: 1, nextCursor: null });
        markRead.mockResolvedValue({ id: "a", readAt: "2026-09-25T03:00:00Z", unreadCount: 0 });
        renderBell("ANALYST");
        await openPanel();
        await user.click(await screen.findByRole("button", { name: /Title a/ }));

        expect(markRead).toHaveBeenCalledWith("fake-token", "a");
        expect(where()).toHaveTextContent("/candidates/N1234567");
        expect(JSON.parse(where().dataset.state!)).toEqual({ fromNotification: true });
        expect(screen.queryByText("Title a")).toBeNull(); // the panel is closed
        expect(screen.getByRole("button", { name: "Notifications" })).toHaveAttribute("aria-expanded", "false");
        await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument()); // count 0
    });

    test("a read notification still opens its page (and is not marked again)", async () => {
        list.mockResolvedValue({ items: [note("a", "2026-09-25T02:00:00Z", { type: "D1_UNALLOCATED_CANDIDATES" })], unreadCount: 0, nextCursor: null });
        renderBell("TEAM_LEAD");
        await openPanel();
        await user.click(await screen.findByRole("button", { name: /Title a/ }));
        expect(markRead).not.toHaveBeenCalled();
        expect(where()).toHaveTextContent("/work-allocation");
    });

    test("a failed mark-read still navigates; the unread state rolls back", async () => {
        list.mockResolvedValue({ items: [note("a", null, { type: "C1_NEW_JOB_ADDED", jobId: "job-1" })], unreadCount: 1, nextCursor: null });
        markRead.mockRejectedValue(new Error("nope"));
        renderBell("JOB_HANDLER");
        await openPanel();
        await user.click(await screen.findByRole("button", { name: /Title a/ }));
        expect(where()).toHaveTextContent("/jobs/job-1");
        await waitFor(() => expect(screen.getByRole("button", { name: "Notifications (1 unread)" })).toBeInTheDocument());
    });

    test("without a candidate or job id the section page opens", async () => {
        list.mockResolvedValue({ items: [note("a", null, { type: "A1_NEW_CANDIDATES_ALLOCATED", candidateId: null }), note("b", null, { type: "C1_NEW_JOB_ADDED" })], unreadCount: 2, nextCursor: null });
        markRead.mockResolvedValue({ id: "a", readAt: "2026-09-25T03:00:00Z", unreadCount: 1 });
        renderBell("ANALYST");
        await openPanel();
        await user.click(await screen.findByRole("button", { name: /Title a/ }));
        expect(where()).toHaveTextContent(/^\/candidates$/);
        expect(JSON.parse(where().dataset.state!)).toBeNull();
    });

    test("a role that cannot open any page for it stays put, sees a message, and the notification is still marked read", async () => {
        list.mockResolvedValue({ items: [note("a", null, { type: "E9_GOOGLE_SHEET_SYNC_FAILED" })], unreadCount: 1, nextCursor: null });
        markRead.mockResolvedValue({ id: "a", readAt: "2026-09-25T03:00:00Z", unreadCount: 0 });
        renderBell("TEAM_LEAD");
        await openPanel();
        await user.click(await screen.findByRole("button", { name: /Title a/ }));
        expect(markRead).toHaveBeenCalledWith("fake-token", "a");
        expect(where()).toHaveTextContent("/start");
        expect(screen.getByRole("status")).toHaveTextContent(NO_ACCESS_MESSAGE);
        expect(screen.getByText("Title a")).toBeInTheDocument(); // the panel stays open
        await waitFor(() => expect(screen.getByText("Title a").closest("li")).toHaveAttribute("data-unread", "false"));
    });

    test("a role without the ADMIN-only Documents page is sent to the Candidates list instead", async () => {
        list.mockResolvedValue({ items: [note("a", null, { type: "E7_DOCUMENTS_AWAITING_REVIEW" })], unreadCount: 1, nextCursor: null });
        markRead.mockResolvedValue({ id: "a", readAt: "2026-09-25T03:00:00Z", unreadCount: 0 });
        renderBell("TEAM_LEAD");
        await openPanel();
        await user.click(await screen.findByRole("button", { name: /Title a/ }));
        expect(where()).toHaveTextContent(/^\/candidates$/);
    });

    test("a notification with no page (password reminder) is only marked read", async () => {
        list.mockResolvedValue({ items: [note("a", null, { type: "A3_PASSWORD_CHANGE_REMINDER" })], unreadCount: 1, nextCursor: null });
        markRead.mockResolvedValue({ id: "a", readAt: "2026-09-25T03:00:00Z", unreadCount: 0 });
        renderBell("ANALYST");
        await openPanel();
        await user.click(await screen.findByRole("button", { name: /Title a/ }));
        expect(markRead).toHaveBeenCalledWith("fake-token", "a");
        expect(where()).toHaveTextContent("/start");
        expect(screen.queryByRole("status")).toBeNull();
    });
});

describe("a notification's record that no longer exists", () => {
    const user = userEvent.setup();

    beforeEach(() => {
        vi.clearAllMocks();
        count.mockResolvedValue({ unreadCount: 1 });
        markRead.mockResolvedValue({ id: "a", readAt: "2026-09-25T03:00:00Z", unreadCount: 0 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const signedInAs = (role: string, routes = {}) => {
        fakeAuth.setSession(SESSION_TOKEN, "admin@example.invalid");
        return stubBackend({ "GET /auth/me": { status: 200, body: { user: userWithRole(role) } }, ...routes });
    };

    test("a deleted candidate: the user lands on the Candidates list with a friendly message, no error", async () => {
        list.mockResolvedValue({ items: [note("a", null, { type: "A4_CANDIDATE_FORM_SUBMITTED", candidateId: "N0000099" })], unreadCount: 1, nextCursor: null });
        signedInAs("ANALYST", { "GET /api/admin/candidates/N0000099": { status: 404, body: { message: "Candidate not found" } } });
        renderApp("/follow-ups");
        await user.click(await screen.findByRole("button", { name: /Notifications/ }, RENDER_STEP));
        await user.click(await screen.findByRole("button", { name: /Title a/ }));

        expect(await screen.findByText(RECORD_GONE.candidate, {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 1, name: "Candidates" })).toBeInTheDocument();
        expect(screen.queryByText("Candidate not found")).toBeNull();
        await user.click(screen.getByRole("button", { name: "Dismiss" }));
        expect(screen.queryByText(RECORD_GONE.candidate)).toBeNull();
    });

    test("a deleted job: the user lands on the Jobs list with a friendly message", async () => {
        list.mockResolvedValue({ items: [note("a", null, { type: "C1_NEW_JOB_ADDED", jobId: "gone-job" })], unreadCount: 1, nextCursor: null });
        signedInAs("JOB_HANDLER", { "GET /api/admin/jobs/gone-job": { status: 404, body: { message: "Job not found" } } });
        renderApp("/agents");
        await user.click(await screen.findByRole("button", { name: /Notifications/ }, RENDER_STEP));
        await user.click(await screen.findByRole("button", { name: /Title a/ }));

        expect(await screen.findByText(RECORD_GONE.job, {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 1, name: "Jobs" })).toBeInTheDocument();
        expect(screen.queryByText("Job not found")).toBeNull();
    });

    test("opened directly (not from a notification), a missing candidate still shows the page's own error", async () => {
        signedInAs("ADMIN", { "GET /api/admin/candidates/N0000099": { status: 404, body: { message: "Candidate not found" } } });
        list.mockResolvedValue({ items: [], unreadCount: 0, nextCursor: null });
        renderApp("/candidates/N0000099");
        expect(await screen.findByText("Candidate not found", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByText(RECORD_GONE.candidate)).toBeNull();
    });
});
