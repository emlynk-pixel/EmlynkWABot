import { useState, useEffect, type FormEvent } from "react";
import { useAuth } from "../auth/AuthProvider";
import { Icon } from "../components/Icon";
import {
    inviteAdmin,
    listInvitations,
    revokeInvitation,
    deleteInvitation,
    type AdminInvitationSummary,
} from "../api/admin";
import { ApiError } from "../api/client";

const dateFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Colombo",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
});

export function InvitationsPage() {
    const { admin, token } = useAuth();
    const isAdmin = admin?.role === "ADMIN";

    const [invitations, setInvitations] = useState<AdminInvitationSummary[]>([]);
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);

    // Form state
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<"ANALYST" | "ADMIN">("ANALYST");
    const [submitting, setSubmitting] = useState(false);
    const [formSuccess, setFormSuccess] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);

    // Revoke & Delete action state
    const [revokingId, setRevokingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    async function loadInvitations() {
        if (!isAdmin) return;
        setRefreshing(true);
        setFetchError(null);
        try {
            const data = await listInvitations(token ?? undefined);
            setInvitations(data.invitations);
        } catch (err) {
            setFetchError(err instanceof ApiError ? err.message : "Failed to load invitations.");
        } finally {
            setRefreshing(false);
            setLoading(false);
        }
    }

    useEffect(() => {
        if (isAdmin) {
            setLoading(true);
            loadInvitations();
        }
    }, [isAdmin]);

    async function handleInviteSubmit(e: FormEvent) {
        e.preventDefault();
        setFormError(null);
        setFormSuccess(null);

        if (!name.trim() || !email.trim()) {
            setFormError("Please enter both a name and an email address.");
            return;
        }

        setSubmitting(true);
        try {
            const result = await inviteAdmin(
                { name: name.trim(), email: email.trim(), role },
                token ?? undefined
            );
            setFormSuccess(`Invitation sent to ${result.invitation.email}. Setup link has been dispatched.`);
            setName("");
            setEmail("");
            setRole("ANALYST");
            loadInvitations();
        } catch (err) {
            setFormError(err instanceof ApiError ? err.message : "Failed to send invitation. Please try again.");
        } finally {
            setSubmitting(false);
        }
    }

    async function handleRevoke(invitationId: string) {
        if (!confirm("Are you sure you want to revoke this invitation? The setup link will become permanently invalid.")) {
            return;
        }

        setRevokingId(invitationId);
        try {
            await revokeInvitation(invitationId, token ?? undefined);
            loadInvitations();
        } catch (err) {
            alert(err instanceof ApiError ? err.message : "Failed to revoke invitation.");
        } finally {
            setRevokingId(null);
        }
    }

    async function handleDelete(invitationId: string) {
        if (!confirm("Are you sure you want to permanently remove this invitation from the list?")) {
            return;
        }

        setDeletingId(invitationId);
        try {
            await deleteInvitation(invitationId, token ?? undefined);
            loadInvitations();
        } catch (err) {
            alert(err instanceof ApiError ? err.message : "Failed to remove invitation.");
        } finally {
            setDeletingId(null);
        }
    }

    if (!isAdmin) {
        return (
            <div className="mx-auto max-w-4xl p-6">
                <div className="rounded border border-critical-border bg-critical-bg p-6 text-center text-critical">
                    <Icon name="lock" className="mx-auto size-8 text-critical mb-2" />
                    <h2 className="text-headline-sm font-semibold">Access Restricted</h2>
                    <p className="mt-1 text-body-sm text-ink-muted">
                        Only administrators with the <strong>ADMIN</strong> role can invite new staff and manage invitation tokens.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8 p-4 md:p-6 max-w-6xl mx-auto">
            {/* Page Header */}
            <div>
                <h1 className="text-headline-lg text-ink font-bold">Admin Invitations</h1>
                <p className="mt-1 text-body-md text-ink-muted">
                    Invite new administrators, analysts, and viewers. Invites are cryptographically signed, expire after 24 hours, and can only be used once.
                </p>
            </div>

            {/* Invite Form Card */}
            <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
                <div className="flex items-center gap-2 border-b border-border pb-4 mb-5">
                    <Icon name="person_add" className="size-5 text-primary" />
                    <h2 className="text-headline-sm font-semibold text-ink">Invite New Administrator</h2>
                </div>

                {formSuccess && (
                    <div className="mb-5 flex items-start gap-3 rounded border border-verified-border bg-verified-bg p-4 text-body-sm text-verified" role="alert">
                        <Icon name="check_circle" className="size-5 shrink-0" />
                        <div>
                            <p className="font-medium">Invitation Dispatched</p>
                            <p className="text-ink-soft">{formSuccess}</p>
                        </div>
                    </div>
                )}

                {formError && (
                    <div className="mb-5 flex items-start gap-3 rounded border border-critical-border bg-critical-bg p-4 text-body-sm text-critical" role="alert">
                        <Icon name="error" className="size-5 shrink-0" />
                        <div>
                            <p className="font-medium">Cannot Send Invitation</p>
                            <p className="text-ink-soft">{formError}</p>
                        </div>
                    </div>
                )}

                <form onSubmit={handleInviteSubmit} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                            <label htmlFor="invite-name" className="block text-label-md text-ink font-medium mb-1">
                                Full Name <span className="text-critical">*</span>
                            </label>
                            <input
                                id="invite-name"
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="e.g. Chaminda Silva"
                                required
                                maxLength={100}
                                className="h-9 w-full rounded border border-border-strong bg-surface px-3 text-body-sm text-ink placeholder:text-ink-subtle focus:border-primary focus:outline-none"
                            />
                        </div>

                        <div>
                            <label htmlFor="invite-email" className="block text-label-md text-ink font-medium mb-1">
                                Email Address <span className="text-critical">*</span>
                            </label>
                            <input
                                id="invite-email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="e.g. chaminda@example.com"
                                required
                                maxLength={254}
                                className="h-9 w-full rounded border border-border-strong bg-surface px-3 text-body-sm text-ink placeholder:text-ink-subtle focus:border-primary focus:outline-none"
                            />
                        </div>

                        <div>
                            <label htmlFor="invite-role" className="block text-label-md text-ink font-medium mb-1">
                                Assigned Role <span className="text-critical">*</span>
                            </label>
                            <select
                                id="invite-role"
                                value={role}
                                onChange={(e) => setRole(e.target.value as "ANALYST" | "ADMIN")}
                                className="h-9 w-full rounded border border-border-strong bg-surface px-3 text-body-sm text-ink focus:border-primary focus:outline-none"
                            >
                                <option value="ANALYST">Analyst</option>
                                <option value="ADMIN">Admin, Managers</option>
                            </select>
                        </div>
                    </div>

                    <div className="flex justify-end pt-2">
                        <button
                            type="submit"
                            disabled={submitting}
                            className="flex h-9 items-center gap-2 rounded bg-primary px-4 text-label-md font-medium text-on-primary shadow-sm hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            <Icon
                                name={submitting ? "progress_activity" : "send"}
                                className={`size-4 ${submitting ? "animate-spin" : ""}`}
                            />
                            <span>{submitting ? "Dispatching…" : "Send Invitation"}</span>
                        </button>
                    </div>
                </form>
            </div>

            {/* Invitations Table Card */}
            <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
                <div className="flex items-center justify-between border-b border-border pb-4 mb-4">
                    <div>
                        <h2 className="text-headline-sm font-semibold text-ink">Invitation Status & History</h2>
                        <p className="text-body-sm text-ink-muted">Tracking of all issued setup tokens and account activations.</p>
                    </div>
                    <button
                        type="button"
                        onClick={loadInvitations}
                        disabled={refreshing}
                        className="flex h-8 items-center gap-1 rounded border border-border-strong bg-surface px-3 text-label-sm text-ink hover:bg-canvas disabled:opacity-50"
                        title="Refresh invitation list"
                    >
                        <Icon name="refresh" className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
                        <span>Refresh</span>
                    </button>
                </div>

                {fetchError && (
                    <div className="mb-4 rounded border border-critical-border bg-critical-bg p-3 text-body-sm text-critical">
                        {fetchError}
                    </div>
                )}

                {loading ? (
                    <div className="py-12 text-center text-ink-muted">
                        <Icon name="progress_activity" className="mx-auto size-6 animate-spin text-primary mb-2" />
                        <p className="text-body-sm">Loading invitations…</p>
                    </div>
                ) : invitations.length === 0 ? (
                    <div className="py-12 text-center text-ink-subtle">
                        <Icon name="mail" className="mx-auto size-8 mb-2 opacity-50" />
                        <p className="text-body-md font-medium">No invitations found</p>
                        <p className="text-body-sm mt-1">Use the form above to invite your first colleague.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-body-sm">
                            <thead className="border-b border-border bg-canvas text-label-sm text-ink-subtle uppercase">
                                <tr>
                                    <th className="py-3 px-4">Invitee</th>
                                    <th className="py-3 px-4">Role</th>
                                    <th className="py-3 px-4">Status</th>
                                    <th className="py-3 px-4">Expires</th>
                                    <th className="py-3 px-4">Sent</th>
                                    <th className="py-3 px-4 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {invitations.map((inv) => (
                                    <tr key={inv.invitationId} className="hover:bg-canvas-muted/50 transition-colors">
                                        <td className="py-3 px-4">
                                            <p className="font-medium text-ink">{inv.name}</p>
                                            <p className="text-ink-subtle text-label-sm">{inv.email}</p>
                                        </td>
                                        <td className="py-3 px-4">
                                            <span className="inline-block rounded px-2 py-0.5 text-label-caps font-semibold bg-canvas-muted text-ink-soft border border-border">
                                                {inv.role}
                                            </span>
                                        </td>
                                        <td className="py-3 px-4">
                                            {inv.status === "PENDING" && (
                                                <span className="inline-flex items-center gap-1 rounded bg-review-bg text-review border border-review-border px-2 py-0.5 text-label-sm font-medium">
                                                    <Icon name="schedule" className="size-3.5" />
                                                    Pending Setup
                                                </span>
                                            )}
                                            {inv.status === "ACCEPTED" && (
                                                <span className="inline-flex items-center gap-1 rounded bg-verified-bg text-verified border border-verified-border px-2 py-0.5 text-label-sm font-medium">
                                                    <Icon name="check_circle" className="size-3.5" />
                                                    Active
                                                </span>
                                            )}
                                            {inv.status === "EXPIRED" && (
                                                <span className="inline-flex items-center gap-1 rounded bg-critical-bg text-critical border border-critical-border px-2 py-0.5 text-label-sm font-medium">
                                                    <Icon name="error" className="size-3.5" />
                                                    Expired
                                                </span>
                                            )}
                                            {inv.status === "REVOKED" && (
                                                <span className="inline-flex items-center gap-1 rounded bg-pending-bg text-pending border border-pending-border px-2 py-0.5 text-label-sm font-medium">
                                                    <Icon name="cancel" className="size-3.5" />
                                                    Revoked
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-3 px-4 text-ink-muted text-label-sm">
                                            {dateFormat.format(new Date(inv.expiresAt))}
                                        </td>
                                        <td className="py-3 px-4 text-ink-subtle text-label-sm">
                                            {dateFormat.format(new Date(inv.createdAt))}
                                        </td>
                                        <td className="py-3 px-4 text-right">
                                            {inv.status === "PENDING" ? (
                                                <button
                                                    type="button"
                                                    onClick={() => handleRevoke(inv.invitationId)}
                                                    disabled={revokingId === inv.invitationId}
                                                    className="inline-flex items-center gap-1 text-label-sm text-critical hover:underline disabled:opacity-50"
                                                    title="Revoke invitation"
                                                >
                                                    <Icon name="cancel" className="size-4" />
                                                    <span>{revokingId === inv.invitationId ? "Revoking…" : "Revoke"}</span>
                                                </button>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => handleDelete(inv.invitationId)}
                                                    disabled={deletingId === inv.invitationId}
                                                    className="inline-flex items-center gap-1 text-label-sm text-ink-subtle hover:text-critical hover:underline disabled:opacity-50"
                                                    title="Remove from list permanently"
                                                >
                                                    <Icon name="delete" className="size-4" />
                                                    <span>{deletingId === inv.invitationId ? "Removing…" : "Remove from list"}</span>
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
