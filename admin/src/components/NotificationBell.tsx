import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { getUnreadCount, listNotifications, markNotificationRead, type AdminNotification } from "../api/notifications";
import { NO_ACCESS_MESSAGE, notificationTarget, type NotificationNavState } from "../notifications/targets";
import { Icon } from "./Icon";

// The header bell: the signed-in admin's server-side notification feed (every role). Read state lives on
// the server. The unread count is polled while the tab is visible; the list loads when the panel opens.
// Clicking a notification marks it read, then opens the page it is about (notifications/targets.ts) and
// closes the panel. One with no page only gets marked read; one whose pages the role cannot open keeps
// the panel open with a short message.

const POLL_MS = 30_000;
const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Colombo", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function formatWhen(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
}

export function NotificationBell() {
    const { user, token } = useAuth();
    const navigate = useNavigate();
    const [isOpen, setIsOpen] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [items, setItems] = useState<AdminNotification[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [unreadCount, setUnreadCount] = useState(0);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const countRef = useRef(0);
    const openRef = useRef(false);
    const seenIdsRef = useRef(new Set<string>());
    const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
    const badgeRef = useRef({ count: 0, dir: "up" });
    countRef.current = unreadCount;
    openRef.current = isOpen;
    if (badgeRef.current.count !== unreadCount) {
        badgeRef.current = { count: unreadCount, dir: unreadCount < badgeRef.current.count ? "down" : "up" };
    }

    const loadList = useCallback(async (signal?: AbortSignal) => {
        if (!token) return;
        setLoading(true);
        setError(false);
        try {
            const page = await listNotifications(token, { limit: 30 }, signal);
            // Presentation only: a refresh while the panel is open that brings ids not seen before is a
            // genuine arrival. The load that happens as the panel opens never animates.
            const seen = seenIdsRef.current;
            if (openRef.current && seen.size > 0) {
                const arrived = page.items.filter((i) => !seen.has(i.id)).map((i) => i.id);
                if (arrived.length > 0) setFreshIds((current) => new Set([...current, ...arrived]));
            }
            page.items.forEach((i) => seen.add(i.id));
            setItems(page.items);
            setNextCursor(page.nextCursor);
            setUnreadCount(page.unreadCount);
        } catch (e) {
            if ((e as Error)?.name !== "AbortError") setError(true);
        } finally {
            setLoading(false);
        }
    }, [token]);

    const refreshCount = useCallback(async (signal?: AbortSignal) => {
        if (!token) return;
        try {
            const { unreadCount: next } = await getUnreadCount(token, signal);
            const increased = next > countRef.current;
            setUnreadCount(next);
            if (increased && openRef.current) void loadList();
        } catch {
            // A failed poll keeps the last count; the next tick retries.
        }
    }, [token, loadList]);

    // Initial count, then every 30s while the tab is visible; refetch when the tab returns.
    useEffect(() => {
        if (!token) return;
        const controller = new AbortController();
        void refreshCount(controller.signal);
        const timer = window.setInterval(() => {
            if (!document.hidden) void refreshCount();
        }, POLL_MS);
        const onVisible = () => {
            if (!document.hidden) void refreshCount();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            controller.abort();
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [token, refreshCount]);

    // Close on click outside
    useEffect(() => {
        if (!isOpen) return;
        const handleDocumentClick = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setIsOpen(false);
        };
        document.addEventListener("mousedown", handleDocumentClick);
        return () => document.removeEventListener("mousedown", handleDocumentClick);
    }, [isOpen]);

    const handleToggle = () => {
        if (!isOpen) {
            setFreshIds(new Set());
            setNotice(null);
            void loadList();
            void refreshCount();
        }
        setIsOpen(!isOpen);
    };

    const loadMore = async () => {
        if (!token || !nextCursor || loadingMore) return;
        setLoadingMore(true);
        try {
            const page = await listNotifications(token, { limit: 30, cursor: nextCursor });
            setItems((current) => {
                const seen = new Set(current.map((i) => i.id));
                return [...current, ...page.items.filter((i) => !seen.has(i.id))];
            });
            setNextCursor(page.nextCursor);
            setUnreadCount(page.unreadCount);
        } catch {
            setError(true);
        } finally {
            setLoadingMore(false);
        }
    };

    const markRead = async (item: AdminNotification) => {
        if (!token || item.readAt) return;
        const optimisticAt = new Date().toISOString();
        setItems((current) => current.map((i) => (i.id === item.id ? { ...i, readAt: optimisticAt } : i)));
        setUnreadCount((c) => Math.max(0, c - 1));
        try {
            const result = await markNotificationRead(token, item.id);
            setItems((current) => current.map((i) => (i.id === item.id ? { ...i, readAt: result.readAt } : i)));
            setUnreadCount(result.unreadCount);
        } catch {
            // Roll back.
            setItems((current) => current.map((i) => (i.id === item.id ? { ...i, readAt: null } : i)));
            setUnreadCount((c) => c + 1);
        }
    };

    const openItem = (item: AdminNotification) => {
        // Not awaited: the bell stays mounted across pages, so the read state (and a rollback) still lands.
        void markRead(item);
        const target = notificationTarget(item, user);
        if (target.kind === "open") {
            setNotice(null);
            setIsOpen(false);
            const state: NotificationNavState | undefined = target.record ? { fromNotification: true } : undefined;
            navigate(target.to, { state });
        } else if (target.kind === "denied") {
            setNotice(NO_ACCESS_MESSAGE);
        }
    };

    if (!user) return null;

    const badgeText = unreadCount > 99 ? "99+" : unreadCount > 0 ? String(unreadCount) : null;

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                type="button"
                onClick={handleToggle}
                aria-haspopup="true"
                aria-expanded={isOpen}
                className="relative flex h-8 items-center justify-center rounded-lg border border-border-strong bg-surface px-2 text-ink-soft hover:border-border-focus hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-60"
                aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications"}
            >
                <Icon name={badgeText ? "notifications_active" : "notifications"} className="size-4" />
                {badgeText && (
                    // Keyed by the count so each change replays the pop; the number slides in when it goes down.
                    <span key={unreadCount} aria-hidden="true" className="notif-badge-pop absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center overflow-hidden rounded-full bg-critical px-1 text-label-sm font-medium leading-none text-on-critical">
                        <span className={badgeRef.current.dir === "down" ? "notif-badge-down" : undefined}>{badgeText}</span>
                    </span>
                )}
            </button>

            {isOpen && (
                <div className="absolute right-0 top-full z-50 mt-2 flex max-h-[85vh] w-80 flex-col rounded-xl border border-border bg-surface shadow-lg sm:w-96">
                    <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
                        <h3 className="font-medium text-ink">Notifications</h3>
                    </div>
                    {notice && <p role="status" className="shrink-0 border-b border-border px-4 py-2 text-body-sm text-ink-muted">{notice}</p>}

                    <div className="min-h-[100px] flex-1 overflow-y-auto">
                        {loading && items.length === 0 ? (
                            <div className="flex h-32 items-center justify-center text-body-sm text-ink-subtle">
                                <Icon name="progress_activity" className="mr-2 size-5 animate-spin" /> Loading...
                            </div>
                        ) : error && items.length === 0 ? (
                            <div role="alert" className="flex h-32 items-center justify-center px-4 text-center text-body-sm text-critical">
                                Could not load notifications. Please try again.
                            </div>
                        ) : items.length === 0 ? (
                            <div className="flex h-32 items-center justify-center text-body-sm text-ink-subtle">
                                You have no notifications.
                            </div>
                        ) : (
                            <>
                                <ul className="divide-y divide-border">
                                    {items.map((item) => {
                                        const unread = !item.readAt;
                                        return (
                                            <li
                                                key={item.id}
                                                data-unread={unread ? "true" : "false"}
                                                className={`transition-colors duration-300 motion-reduce:transition-none ${unread ? "bg-primary-soft" : "bg-surface"} ${freshIds.has(item.id) ? "notif-arrive" : ""}`}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() => openItem(item)}
                                                    className="relative flex w-full flex-col p-4 pl-6 text-left transition-colors hover:bg-canvas-muted"
                                                >
                                                    {/* Bar and dot are always rendered so the row never shifts; only opacity/transform change. */}
                                                    <span
                                                        data-testid="notif-bar"
                                                        aria-hidden="true"
                                                        className={`absolute inset-y-0 left-0 w-1 origin-center bg-primary transition-transform duration-300 ease-out motion-reduce:transition-none ${unread ? "scale-y-100" : "scale-y-0"}`}
                                                    />
                                                    <span
                                                        data-testid="notif-dot"
                                                        aria-hidden="true"
                                                        className={`absolute left-3 top-[22px] size-2 rounded-full bg-primary transition-opacity duration-200 motion-reduce:transition-none ${unread ? "opacity-100" : "opacity-0"}`}
                                                    />
                                                    <span className={`text-label-md transition-colors duration-300 motion-reduce:transition-none ${unread ? "font-bold text-ink" : "font-normal text-ink-muted"}`}>{item.title}</span>
                                                    <span className={`mt-0.5 text-body-sm transition-colors duration-300 motion-reduce:transition-none [overflow-wrap:anywhere] ${unread ? "text-ink-soft" : "text-ink-muted"}`}>{item.message}</span>
                                                    <span className={`mt-1 text-label-sm transition-colors duration-300 motion-reduce:transition-none ${unread ? "text-ink-muted" : "text-ink-subtle"}`}>{formatWhen(item.createdAt)}</span>
                                                    <span className="sr-only">{unread ? "Unread" : "Read"}</span>
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                                {error && (
                                    <p role="alert" className="px-4 py-2 text-center text-body-sm text-critical">Could not load notifications. Please try again.</p>
                                )}
                                {nextCursor && (
                                    <div className="border-t border-border p-2 text-center">
                                        <button
                                            type="button"
                                            onClick={() => void loadMore()}
                                            disabled={loadingMore}
                                            className="text-label-sm text-primary hover:underline disabled:opacity-60"
                                        >
                                            {loadingMore ? "Loading..." : "Load more"}
                                        </button>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
