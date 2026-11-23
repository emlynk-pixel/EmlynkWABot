import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as authProvider from "../auth/AuthProvider";
import { NotificationBell } from "../components/NotificationBell";
import * as api from "../api/notifications";

vi.mock("../api/notifications", () => ({
    listNotifications: vi.fn(),
    getUnreadCount: vi.fn(),
    markNotificationRead: vi.fn(),
}));

const MOCK_USER = { userId: "user-1", email: "test@example.com", name: "Test Admin", role: "ADMIN", status: "ACTIVE" };

const note = (id: string, readAt: string | null = null) => ({
    id, type: "GENERIC", title: `Title ${id}`, message: `Message ${id}`, createdAt: "2026-09-25T01:00:00Z", readAt,
});

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
    return render(<NotificationBell />);
}

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
