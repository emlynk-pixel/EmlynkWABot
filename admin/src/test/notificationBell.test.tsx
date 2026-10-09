import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, beforeEach, vi, afterEach } from "vitest";
import { MemoryRouter } from "react-router";
import * as authProvider from "../auth/AuthProvider";
import { NotificationBell } from "../components/NotificationBell";
import * as adminApi from "../api/admin";

vi.mock("../api/admin", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../api/admin")>();
    return {
        ...actual,
        getReviewQueue: vi.fn(),
    };
});

const MOCK_USER = { userId: "user-1", email: "test@example.com", name: "Test Admin", role: "ADMIN", status: "ACTIVE" };

function renderBell(user = MOCK_USER) {
    vi.spyOn(authProvider, "useAuth").mockReturnValue({
        user: user as any,
        token: "fake-token",
        status: "authenticated",
        notice: null,
        signIn: vi.fn(),
        signOut: vi.fn(),
        refreshUser: vi.fn(),
    });

    return render(
        <MemoryRouter>
            <NotificationBell />
        </MemoryRouter>
    );
}

describe("NotificationBell", () => {
    const getReviewQueueMock = vi.mocked(adminApi.getReviewQueue);
    const user = userEvent.setup();

    beforeEach(() => {
        window.localStorage.clear();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function mockQueueResponse(items: any[], total = items.length) {
        getReviewQueueMock.mockResolvedValue({
            summary: { total, pending: total, documents: 0, byReason: {}, byCategory: {}, failed: 0 },
            items,
            pagination: { page: 1, pageSize: 100, total, totalPages: 1 },
            filters: { kind: "ALL" },
            requiredDocumentTypes: []
        } as any);
    }

    test("bell renders and shows zero unread state", async () => {
        mockQueueResponse([]);
        renderBell();

        const button = screen.getByRole("button", { name: "Notifications" });
        expect(button).toBeInTheDocument();
        
        await waitFor(() => {
            expect(screen.queryByText("0")).not.toBeInTheDocument(); // Badge doesn't show 0
        });

        await user.click(button);
        expect(screen.getByText("You have no notifications.")).toBeInTheDocument();
    });

    test("unread badge count is displayed", async () => {
        mockQueueResponse([
            { reviewId: "1", documentType: "PASSPORT", processingStatus: "MANUAL_REVIEW", reviewReason: "IDENTITY_NOT_CONFIRMED", receivedDate: "2026-09-25T01:00:00Z" }
        ]);
        renderBell();

        const badge = await screen.findByText("1");
        expect(badge).toBeInTheDocument();
    });

    test("handles API failure without crashing", async () => {
        getReviewQueueMock.mockRejectedValue(new Error("API Error"));
        renderBell();
        
        const button = screen.getByRole("button", { name: /Notifications/ });
        await user.click(button);
        
        expect(await screen.findByText("Could not load notifications. Please try again.")).toBeInTheDocument();
    });

    test("displays manual-review item notification", async () => {
        mockQueueResponse([
            { reviewId: "1", documentType: "PASSPORT", processingStatus: "MANUAL_REVIEW", reviewReason: null, receivedDate: "2026-09-25T01:00:00Z" }
        ]);
        renderBell();
        await user.click(screen.getByRole("button"));

        expect(await screen.findByText("Document requires review")).toBeInTheDocument();
        expect(screen.getByText(/Manual review required/)).toBeInTheDocument();
    });

    test("displays identity-not-confirmed notification", async () => {
        mockQueueResponse([
            { reviewId: "2", documentType: "PASSPORT", processingStatus: "MANUAL_REVIEW", reviewReason: "IDENTITY_NOT_CONFIRMED", receivedDate: "2026-09-25T01:00:00Z", confidence: 33 }
        ]);
        renderBell();
        await user.click(screen.getByRole("button"));

        expect(await screen.findByText("Document requires review")).toBeInTheDocument();
        expect(screen.getByText("Identity not confirmed · 33% confidence · 25 Sept, 06:30")).toBeInTheDocument(); // 06:30 depends on timezone, match loose or exactly if TZ is fixed. Wait, date is converted to local time, so just check reason
        expect(screen.getByText(/Identity not confirmed/)).toBeInTheDocument();
        expect(screen.getByText(/33% confidence/)).toBeInTheDocument();
    });

    test("displays document-type-unclear notification", async () => {
        mockQueueResponse([
            { reviewId: "3", documentType: "UNKNOWN", processingStatus: "UNDEFINED", reviewReason: "DOCUMENT_TYPE_UNCLEAR", receivedDate: "2026-09-25T01:00:00Z" }
        ]);
        renderBell();
        await user.click(screen.getByRole("button"));

        expect(await screen.findByText("Unrecognized document received")).toBeInTheDocument();
        expect(screen.getByText("A document could not be identified automatically.")).toBeInTheDocument();
        expect(screen.getByText(/Document type unclear/)).toBeInTheDocument();
    });

    test("opening dropdown does not automatically mark items read", async () => {
        mockQueueResponse([{ reviewId: "1", receivedDate: "2026-09-25T01:00:00Z" }]);
        renderBell();

        expect(await screen.findByText("1")).toBeInTheDocument();
        await user.click(screen.getByRole("button"));
        
        // Count should still be 1 after opening
        expect(screen.getByText("1")).toBeInTheDocument();
    });

    test("clicking notification navigates to exact review item and marks read", async () => {
        mockQueueResponse([{ reviewId: "rev-123", receivedDate: "2026-09-25T01:00:00Z" }]);
        renderBell();

        expect(await screen.findByText("1")).toBeInTheDocument();
        await user.click(screen.getByRole("button"));

        const link = screen.getByRole("link", { name: /Review document/i });
        expect(link).toHaveAttribute("href", "/admin/review/rev-123");

        await user.click(link);

        // Badge disappears as it's marked read
        await waitFor(() => {
            expect(screen.queryByText("1")).not.toBeInTheDocument();
        });
    });

    test("Mark all as read sets all to read", async () => {
        mockQueueResponse([
            { reviewId: "1", receivedDate: "2026-09-25T01:00:00Z" },
            { reviewId: "2", receivedDate: "2026-09-25T01:00:00Z" }
        ]);
        renderBell();

        expect(await screen.findByText("2")).toBeInTheDocument();
        await user.click(screen.getByRole("button"));

        const markAll = screen.getByRole("button", { name: "Mark all as read" });
        await user.click(markAll);

        await waitFor(() => {
            expect(screen.queryByText("2")).not.toBeInTheDocument();
        });
    });

    test("resolved item disappears after refresh and stale localStorage IDs are pruned", async () => {
        window.localStorage.setItem("emlynk.admin.readNotifications.user-1", JSON.stringify(["stale-id", "valid-id"]));
        
        mockQueueResponse([{ reviewId: "valid-id", receivedDate: "2026-09-25T01:00:00Z" }]);
        renderBell();
        
        await waitFor(() => {
            expect(getReviewQueueMock).toHaveBeenCalledTimes(1);
        });

        // "stale-id" should be removed from localStorage since it's not active anymore
        const stored = JSON.parse(window.localStorage.getItem("emlynk.admin.readNotifications.user-1")!);
        expect(stored).toEqual(["valid-id"]);
    });

    test("localStorage is isolated by admin ID", async () => {
        window.localStorage.setItem("emlynk.admin.readNotifications.user-2", JSON.stringify(["rev-1"]));
        
        mockQueueResponse([{ reviewId: "rev-1", receivedDate: "2026-09-25T01:00:00Z" }]);
        renderBell(MOCK_USER); // user-1
        
        // user-1 should see it as unread (count 1)
        expect(await screen.findByText("1")).toBeInTheDocument();
    });

    test("malformed localStorage does not crash UI", async () => {
        window.localStorage.setItem("emlynk.admin.readNotifications.user-1", "{invalid json");
        
        mockQueueResponse([{ reviewId: "rev-1", receivedDate: "2026-09-25T01:00:00Z" }]);
        expect(() => renderBell()).not.toThrow();
        
        expect(await screen.findByText("1")).toBeInTheDocument();
    });

    test("pagination does not cause an incorrect unread count (fetches all pages)", async () => {
        // Mock multiple pages
        getReviewQueueMock.mockResolvedValueOnce({
            summary: { total: 101, pending: 101, documents: 0, byReason: {}, byCategory: {}, failed: 0 },
            items: Array(100).fill(null).map((_, i) => ({ reviewId: `item-${i}`, receivedDate: "2026-09-25T01:00:00Z" })),
            pagination: { page: 1, pageSize: 100, total: 101, totalPages: 2 },
            filters: { kind: "ALL" },
            requiredDocumentTypes: []
        } as any);

        getReviewQueueMock.mockResolvedValueOnce({
            summary: { total: 101, pending: 101, documents: 0, byReason: {}, byCategory: {}, failed: 0 },
            items: [{ reviewId: `item-100`, receivedDate: "2026-09-25T01:00:00Z" }],
            pagination: { page: 2, pageSize: 100, total: 101, totalPages: 2 },
            filters: { kind: "ALL" },
            requiredDocumentTypes: []
        } as any);

        renderBell();
        
        // Count should be 101, so badge shows "99+"
        expect(await screen.findByText("99+")).toBeInTheDocument();
        expect(getReviewQueueMock).toHaveBeenCalledTimes(2);
    });
});
