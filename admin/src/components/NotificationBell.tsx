import { useEffect, useState, useRef, useCallback } from "react";
import { Link } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { getReviewQueue } from "../api/admin";
import { Icon } from "./Icon";
import { reviewReasonLabel } from "./reviewLabels";

// Extract base type for items from the queue
type NotificationItem = {
    reviewId: string;
    documentType: string;
    receivedDate: string;
    reviewReason: string | null;
    confidence?: number | null; // Available on document items
    processingStatus?: string;
    verificationStatus?: string;
    identityStatus?: string;
};

const STORAGE_KEY_PREFIX = "emlynk.admin.readNotifications.";

function getReadIds(adminId: string): string[] {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY_PREFIX + adminId);
        if (stored) {
            const parsed = JSON.parse(stored);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        }
    } catch {
        // safe fallback for malformed localStorage
    }
    return [];
}

function saveReadIds(adminId: string, ids: string[]) {
    try {
        window.localStorage.setItem(STORAGE_KEY_PREFIX + adminId, JSON.stringify(ids));
    } catch {
        // safe fallback if storage is full/unavailable
    }
}

export function NotificationBell() {
    const { admin, token } = useAuth();
    const [isOpen, setIsOpen] = useState(false);
    const [items, setItems] = useState<NotificationItem[]>([]);
    const [readIds, setReadIds] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Close on click outside
    useEffect(() => {
        if (!isOpen) return;
        const handleDocumentClick = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleDocumentClick);
        return () => document.removeEventListener("mousedown", handleDocumentClick);
    }, [isOpen]);

    const fetchNotifications = useCallback(async (abortSignal?: AbortSignal) => {
        if (!token || !admin) return;
        setLoading(true);
        setError(false);
        try {
            let page = 1;
            const pageSize = 100; // max allowed page size
            const allItems: NotificationItem[] = [];
            let keepFetching = true;

            // Fetch pages until we get all active items up to the maximum queue window
            while (keepFetching) {
                const res = await getReviewQueue(token, { page, pageSize, order: "desc" }, abortSignal);
                const fetchedItems = res.items as unknown as NotificationItem[];
                allItems.push(...fetchedItems);

                if (allItems.length >= res.summary.total || fetchedItems.length < pageSize) {
                    keepFetching = false;
                } else {
                    page++;
                }
            }

            setItems(allItems);

            // Reconcile read IDs: remove stale ones no longer active in the queue
            const currentIds = new Set(allItems.map(i => i.reviewId));
            const storedRead = getReadIds(admin.adminId);
            const validReadIds = storedRead.filter(id => currentIds.has(id));

            saveReadIds(admin.adminId, validReadIds);
            setReadIds(new Set(validReadIds));
        } catch (e: unknown) {
            if ((e as Error)?.name !== "AbortError") {
                setError(true);
            }
        } finally {
            setLoading(false);
        }
    }, [token, admin]);

    // Initial fetch
    useEffect(() => {
        const controller = new AbortController();
        fetchNotifications(controller.signal);
        return () => controller.abort();
    }, [fetchNotifications]);

    // Refresh when dropdown is opened
    const handleToggle = () => {
        if (!isOpen) {
            fetchNotifications();
        }
        setIsOpen(!isOpen);
    };

    const markAsRead = (reviewId: string) => {
        if (!admin || readIds.has(reviewId)) return;
        const next = new Set(readIds);
        next.add(reviewId);
        setReadIds(next);
        saveReadIds(admin.adminId, Array.from(next));
    };

    const markAllAsRead = () => {
        if (!admin) return;
        const allIds = items.map(i => i.reviewId);
        setReadIds(new Set(allIds));
        saveReadIds(admin.adminId, allIds);
    };

    const unreadCount = items.length - readIds.size;
    const badgeText = unreadCount > 99 ? "99+" : unreadCount > 0 ? unreadCount.toString() : null;

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                type="button"
                onClick={handleToggle}
                className="relative flex h-9 items-center justify-center rounded-md border border-border-strong bg-surface px-2 text-ink-soft hover:border-border-focus hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-60"
                aria-label={badgeText ? `Notifications (${badgeText} unread)` : "Notifications"}
            >
                <Icon name={badgeText ? "notifications_active" : "notifications"} className="size-4" />
                {badgeText && (
                    <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-critical px-1 text-[10px] font-medium leading-none text-on-critical">
                        {badgeText}
                    </span>
                )}
            </button>

            {isOpen && (
                <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 rounded-lg border border-border bg-surface shadow-lg z-50 flex flex-col max-h-[85vh]">
                    <div className="flex items-center justify-between border-b border-border px-4 py-3 shrink-0">
                        <h3 className="font-medium text-ink">Notifications</h3>
                        {unreadCount > 0 && (
                            <button
                                type="button"
                                onClick={markAllAsRead}
                                className="text-label-sm text-primary hover:underline"
                            >
                                Mark all as read
                            </button>
                        )}
                    </div>

                    <div className="flex-1 overflow-y-auto min-h-[100px]">
                        {loading && items.length === 0 ? (
                            <div className="flex h-32 items-center justify-center text-ink-subtle text-body-sm">
                                <Icon name="progress_activity" className="size-5 animate-spin mr-2" /> Loading...
                            </div>
                        ) : error && items.length === 0 ? (
                            <div className="flex h-32 items-center justify-center text-critical text-body-sm px-4 text-center">
                                Could not load notifications. Please try again.
                            </div>
                        ) : items.length === 0 ? (
                            <div className="flex h-32 items-center justify-center text-ink-subtle text-body-sm">
                                You have no notifications.
                            </div>
                        ) : (
                            <ul className="divide-y divide-border">
                                {items.map(item => {
                                    const isRead = readIds.has(item.reviewId);

                                    let title = "Document requires review";
                                    let body = "A document requires manual attention.";
                                    let meta = "";

                                    if (item.reviewReason === "DOCUMENT_TYPE_UNCLEAR") {
                                        title = "Unrecognized document received";
                                        body = "A document could not be identified automatically.";
                                        meta = "Document type unclear";
                                    } else if (item.reviewReason === "IDENTITY_NOT_CONFIRMED") {
                                        body = "A document could not be securely matched to a candidate.";
                                        meta = "Identity not confirmed";
                                    } else if (item.reviewReason) {
                                        // Some type coercion since reviewReasonLabel expects specific enum values
                                        meta = reviewReasonLabel(item.reviewReason as any) || "Manual review required";
                                    } else {
                                        meta = "Manual review required";
                                    }

                                    if (item.confidence != null && item.confidence > 0) {
                                        meta += ` · ${item.confidence}% confidence`;
                                    }

                                    const time = new Date(item.receivedDate).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
                                    const date = new Date(item.receivedDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
                                    const receivedStr = `${date}, ${time}`;

                                    return (
                                        <li key={item.reviewId} className={`relative flex flex-col p-4 transition-colors hover:bg-canvas-muted ${isRead ? "opacity-60" : "bg-primary-soft/10"}`}>
                                            {!isRead && <span className="absolute left-1.5 top-5 size-1.5 rounded-full bg-primary" aria-hidden="true" />}
                                            <div className="pl-3">
                                                <p className="text-label-md text-ink">{title}</p>
                                                <p className="mt-0.5 text-body-sm text-ink-soft">{body}</p>
                                                <p className="mt-1 text-label-sm text-ink-subtle">{meta} · {receivedStr}</p>
                                                <Link
                                                    to={`/admin/review/${item.reviewId}`}
                                                    onClick={() => {
                                                        markAsRead(item.reviewId);
                                                        setIsOpen(false);
                                                    }}
                                                    className="mt-2 inline-flex text-label-sm text-primary hover:underline"
                                                >
                                                    Review document
                                                </Link>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
