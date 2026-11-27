import { apiRequest } from "./client";

// The signed-in admin's own notification feed (/api/admin/notifications). Every role has one;
// the server scopes it to the caller and keeps the read state.

export type AdminNotification = {
    id: string;
    type: string;
    title: string;
    message: string;
    createdAt: string;
    readAt: string | null;
};

export type NotificationPage = { items: AdminNotification[]; unreadCount: number; nextCursor: string | null };

export function listNotifications(token: string, { limit = 30, cursor }: { limit?: number; cursor?: string | null } = {}, signal?: AbortSignal): Promise<NotificationPage> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return apiRequest(`/api/admin/notifications?${query.toString()}`, { token, signal });
}

export function getUnreadCount(token: string, signal?: AbortSignal): Promise<{ unreadCount: number }> {
    return apiRequest("/api/admin/notifications/unread-count", { token, signal });
}

export function markNotificationRead(token: string, id: string): Promise<{ id: string; readAt: string; unreadCount: number }> {
    return apiRequest(`/api/admin/notifications/${encodeURIComponent(id)}/read`, { method: "POST", token });
}
