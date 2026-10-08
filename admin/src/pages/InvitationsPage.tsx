import { useCallback, useEffect, useState, type FormEvent } from "react";
import { isAdmin, useAuth } from "../auth/AuthProvider";
import { ALL_ROLES, ROLE_LABELS, ROLES, type Role } from "../auth/roles";
import { Icon } from "../components/Icon";
import { deactivateUser, inviteUser, listUsers, type UserSummary } from "../api/admin";
import { ApiError } from "../api/client";
import { FormField, fieldA11y } from "../components/Form";
import { inputClass } from "../components/ui";
import { MAX_EMAIL_LENGTH, MAX_NAME_LENGTH, emailError, nameError } from "../components/validation";

const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Colombo", day: "2-digit", month: "short", year: "numeric" });

const ROLE_HELP: Record<Role, string> = {
    ADMIN: "Everything, including user management and Settings.",
    MANAGER: "Everything except user management and Settings.",
    ANALYST: "Reviews documents and works on candidates; no police-date corrections.",
    REGISTRATION_DESK: "Registers and looks up candidates only.",
};

const STATUS_BADGE: Record<string, { label: string; icon: "schedule" | "check_circle" | "cancel"; className: string }> = {
    INVITED: { label: "Invitation sent", icon: "schedule", className: "bg-review-bg text-review border-review-border" },
    ACTIVE: { label: "Active", icon: "check_circle", className: "bg-verified-bg text-verified border-verified-border" },
    INACTIVE: { label: "Inactive", icon: "cancel", className: "bg-pending-bg text-pending border-pending-border" },
};

// Invite User (ADMIN only). Supabase Auth sends the invitation email and owns
// the password; the role chosen here is stored by the backend in the
// application account, never in the invitation itself.
export function InvitationsPage() {
    const { user, token } = useAuth();
    const allowed = isAdmin(user);

    const [users, setUsers] = useState<UserSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);

    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<Role>(ROLES.ANALYST);
    const [submitting, setSubmitting] = useState(false);
    const [formSuccess, setFormSuccess] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<{ name?: string | null; email?: string | null }>({});
    const [actionError, setActionError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!allowed || !token) return;
        setFetchError(null);
        try {
            setUsers((await listUsers(token)).users);
        } catch (err) {
            setFetchError(err instanceof ApiError ? err.message : "Failed to load users.");
        } finally {
            setLoading(false);
        }
    }, [allowed, token]);

    useEffect(() => {
        load();
    }, [load]);

    async function sendInvite(payload: { name: string; email: string; role: string }) {
        const result = await inviteUser(token ?? "", payload);
        setFormSuccess(result.outcome === "REACTIVATED"
            ? `${result.user.email} already had an account; it is active again as ${ROLE_LABELS[result.user.role as Role] ?? result.user.role}.`
            : `Invitation sent to ${result.user.email}. They set their password from the link in the email.`);
        await load();
    }

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();
        setFormError(null);
        setFormSuccess(null);
        const errors = { name: nameError(name), email: emailError(email, { required: "Enter the person's email address." }) };
        setFieldErrors(errors);
        if (errors.name || errors.email) {
            document.getElementById(errors.name ? "invite-name" : "invite-email")?.focus();
            return;
        }
        setSubmitting(true);
        try {
            await sendInvite({ name: name.trim(), email: email.trim(), role });
            setName("");
            setEmail("");
            setRole(ROLES.ANALYST);
        } catch (err) {
            setFormError(err instanceof ApiError ? err.message : "Failed to send the invitation. Please try again.");
        } finally {
            setSubmitting(false);
        }
    }

    async function resend(target: UserSummary) {
        setBusyId(target.userId);
        setActionError(null);
        setFormSuccess(null);
        try {
            await sendInvite({ name: target.name, email: target.email, role: target.role });
        } catch (err) {
            setActionError(err instanceof ApiError ? err.message : "Failed to send the invitation.");
        } finally {
            setBusyId(null);
        }
    }

    async function deactivate(target: UserSummary) {
        const what = target.status === "INVITED" ? "revoke this invitation" : `deactivate ${target.name}`;
        if (!confirm(`Are you sure you want to ${what}? They will no longer be able to use the admin console.`)) return;
        setBusyId(target.userId);
        setActionError(null);
        try {
            await deactivateUser(token ?? "", target.userId);
            await load();
        } catch (err) {
            setActionError(err instanceof ApiError ? err.message : "Failed to deactivate the user.");
        } finally {
            setBusyId(null);
        }
    }

    if (!allowed) {
        return (
            <div className="mx-auto max-w-4xl p-6">
                <div className="rounded border border-critical-border bg-critical-bg p-6 text-center text-critical">
                    <Icon name="lock" className="mx-auto mb-2 size-8 text-critical" />
                    <h2 className="text-headline-sm font-semibold">Access Restricted</h2>
                    <p className="mt-1 text-body-sm text-ink-muted">Only users with the <strong>Admin</strong> role can invite and manage users.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-6xl space-y-6">
            <div>
                <h1 className="text-headline-lg text-ink">Invite User</h1>
                <p className="mt-1 text-body-sm text-ink-muted">
                    Invite staff by email. They receive a sign-in invitation, choose their own password, and can use the console once they finish setting up.
                </p>
            </div>

            <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
                <div className="mb-5 flex items-center gap-2 border-b border-border pb-4">
                    <Icon name="person_add" className="size-5 text-primary" />
                    <h2 className="text-headline-sm font-semibold text-ink">Invite a new user</h2>
                </div>

                {formSuccess && (
                    <div className="mb-5 flex items-start gap-3 rounded border border-verified-border bg-verified-bg p-4 text-body-sm text-verified" role="status">
                        <Icon name="check_circle" className="size-5 shrink-0" />
                        <p>{formSuccess}</p>
                    </div>
                )}
                {formError && (
                    <div className="mb-5 flex items-start gap-3 rounded border border-critical-border bg-critical-bg p-4 text-body-sm text-critical" role="alert">
                        <Icon name="error" className="size-5 shrink-0" />
                        <div>
                            <p className="font-medium">Cannot send the invitation</p>
                            <p className="text-ink-soft">{formError}</p>
                        </div>
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-5" noValidate>
                    <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-3">
                        <FormField id="invite-name" label="Full Name" required error={fieldErrors.name}>
                            <input
                                {...fieldA11y("invite-name", fieldErrors.name)}
                                type="text"
                                value={name}
                                onChange={(e) => {
                                    setName(e.target.value);
                                    if (fieldErrors.name) setFieldErrors((current) => ({ ...current, name: nameError(e.target.value) }));
                                }}
                                placeholder="e.g. Chaminda Silva"
                                maxLength={MAX_NAME_LENGTH}
                                className={inputClass(Boolean(fieldErrors.name))}
                            />
                        </FormField>
                        <FormField id="invite-email" label="Email Address" required help="The invitation is sent here; it becomes the person's sign-in email." error={fieldErrors.email}>
                            <input
                                {...fieldA11y("invite-email", fieldErrors.email)}
                                type="email"
                                value={email}
                                onChange={(e) => {
                                    setEmail(e.target.value);
                                    if (fieldErrors.email) setFieldErrors((current) => ({ ...current, email: emailError(e.target.value, { required: "Enter the person's email address." }) }));
                                }}
                                placeholder="e.g. chaminda@example.com"
                                maxLength={MAX_EMAIL_LENGTH}
                                className={inputClass(Boolean(fieldErrors.email))}
                            />
                        </FormField>
                        <FormField id="invite-role" label="Role" required help={ROLE_HELP[role]}>
                            <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)} className={inputClass()}>
                                {ALL_ROLES.map((value) => <option key={value} value={value}>{ROLE_LABELS[value]}</option>)}
                            </select>
                        </FormField>
                    </div>
                    <div className="flex justify-end border-t border-border pt-4">
                        <button
                            type="submit"
                            disabled={submitting}
                            className="flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-label-md font-medium text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            <Icon name={submitting ? "progress_activity" : "send"} className={`size-4 ${submitting ? "animate-spin" : ""}`} />
                            <span>{submitting ? "Sending…" : "Send Invitation"}</span>
                        </button>
                    </div>
                </form>
            </div>

            <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
                <div className="mb-4 flex items-center justify-between border-b border-border pb-4">
                    <div>
                        <h2 className="text-headline-sm font-semibold text-ink">Users</h2>
                        <p className="text-body-sm text-ink-muted">Everyone invited to the console and their status.</p>
                    </div>
                    <button type="button" onClick={() => load()} className="flex h-8 items-center gap-1 rounded border border-border-strong bg-surface px-3 text-label-sm text-ink hover:bg-canvas">
                        <Icon name="refresh" className="size-4" />
                        <span>Refresh</span>
                    </button>
                </div>

                {fetchError && <div role="alert" className="mb-4 rounded border border-critical-border bg-critical-bg p-3 text-body-sm text-critical">{fetchError}</div>}
                {actionError && <div role="alert" className="mb-4 rounded border border-critical-border bg-critical-bg p-3 text-body-sm text-critical">{actionError}</div>}

                {loading ? (
                    <div className="py-12 text-center text-ink-muted">
                        <Icon name="progress_activity" className="mx-auto mb-2 size-6 animate-spin text-primary" />
                        <p className="text-body-sm">Loading users…</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-body-sm">
                            <thead className="border-b border-border bg-canvas text-label-caps uppercase text-ink-muted">
                                <tr>
                                    <th className="px-4 py-3">User</th>
                                    <th className="px-4 py-3">Role</th>
                                    <th className="px-4 py-3">Status</th>
                                    <th className="px-4 py-3">Added</th>
                                    <th className="px-4 py-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {users.map((entry) => {
                                    const badge = STATUS_BADGE[entry.status] ?? STATUS_BADGE.INACTIVE;
                                    const self = entry.userId === user?.userId;
                                    return (
                                        <tr key={entry.userId}>
                                            <td className="px-4 py-3">
                                                <p className="font-medium text-ink">{entry.name}</p>
                                                <p className="text-label-sm text-ink-subtle">{entry.email}</p>
                                            </td>
                                            <td className="px-4 py-3">{ROLE_LABELS[entry.role as Role] ?? entry.role}</td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-label-sm font-medium ${badge.className}`}>
                                                    <Icon name={badge.icon} className="size-3.5" />
                                                    {badge.label}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-label-sm text-ink-subtle">{dateFormat.format(new Date(entry.createdDate))}</td>
                                            <td className="space-x-3 px-4 py-3 text-right">
                                                {entry.status !== "ACTIVE" && (
                                                    <button type="button" onClick={() => resend(entry)} disabled={busyId === entry.userId} className="text-label-sm text-primary hover:underline disabled:opacity-50">
                                                        {entry.status === "INVITED" ? "Resend invitation" : "Re-invite"}
                                                    </button>
                                                )}
                                                {entry.status !== "INACTIVE" && !self && (
                                                    <button type="button" onClick={() => deactivate(entry)} disabled={busyId === entry.userId} className="text-label-sm text-critical hover:underline disabled:opacity-50">
                                                        {entry.status === "INVITED" ? "Revoke invitation" : "Deactivate"}
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
