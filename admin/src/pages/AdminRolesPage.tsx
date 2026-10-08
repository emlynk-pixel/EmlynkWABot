import { useState, useEffect } from "react";
import { isAdmin as hasAdminRole, useAuth } from "../auth/AuthProvider";
import { ALL_ROLES, ROLE_LABELS, type Role } from "../auth/roles";
import { Icon } from "../components/Icon";
import { listUsers, updateUserRole, type UserSummary } from "../api/admin";
import { ApiError } from "../api/client";
import { inputClass } from "../components/ui";

const dateFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Colombo",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
});

export function AdminRolesPage() {
    const { user, token } = useAuth();
    const isAdmin = hasAdminRole(user);

    const [admins, setAdmins] = useState<UserSummary[]>([]);
    const [loading, setLoading] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [updatingId, setUpdatingId] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionSuccess, setActionSuccess] = useState<string | null>(null);

    async function loadAdmins() {
        if (!isAdmin) return;
        setFetchError(null);
        try {
            const data = await listUsers(token as string);
            setAdmins(data.users);
        } catch (err) {
            setFetchError(err instanceof ApiError ? err.message : "Failed to load users.");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        if (isAdmin) {
            setLoading(true);
            loadAdmins();
        }
    }, [isAdmin]);

    async function handleRoleChange(adminId: string, newRole: string) {
        if (!confirm(`Are you sure you want to change this user's role to ${ROLE_LABELS[newRole as Role] ?? newRole}?`)) {
            return;
        }

        setUpdatingId(adminId);
        setActionError(null);
        setActionSuccess(null);
        try {
            await updateUserRole(token as string, adminId, newRole);
            setActionSuccess("Role updated successfully.");
            loadAdmins();
        } catch (err) {
            setActionError(err instanceof ApiError ? err.message : "Failed to update role.");
        } finally {
            setUpdatingId(null);
        }
    }

    if (!isAdmin) {
        return (
            <div className="mx-auto max-w-4xl p-6">
                <div className="rounded border border-critical-border bg-critical-bg p-6 text-center text-critical">
                    <Icon name="lock" className="mx-auto size-8 text-critical mb-2" />
                    <h2 className="text-headline-sm font-semibold">Access Restricted</h2>
                    <p className="mt-1 text-body-sm text-ink-muted">
                        Only users with the <strong>Admin</strong> role can change user roles.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-6xl space-y-6">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h1 id="page-title" className="text-headline-lg text-ink">Change Roles</h1>
                    <p className="mt-1 text-body-md text-ink-subtle">
                        Manage the roles of console users. A change applies to their very next request.
                    </p>
                </div>
            </header>

            {actionError && (
                <div className="rounded border border-critical-border bg-critical-bg px-4 py-3 text-body-sm text-critical" role="alert">
                    <Icon name="error" className="mr-2 inline-block size-4 align-text-bottom" />
                    {actionError}
                </div>
            )}
            
            {actionSuccess && (
                <div className="rounded border border-verified-border bg-verified-bg px-4 py-3 text-body-sm text-verified" role="alert">
                    <Icon name="check_circle" className="mr-2 inline-block size-4 align-text-bottom" />
                    {actionSuccess}
                </div>
            )}

            <section aria-labelledby="admins-title">
                <h2 id="admins-title" className="sr-only">Registered Admins</h2>

                <div className="overflow-hidden rounded-lg border border-border bg-surface">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-body-sm text-ink">
                            <thead className="bg-surface-raised text-label-sm text-ink-subtle">
                                <tr>
                                    <th scope="col" className="px-4 py-3 font-semibold">Name & Email</th>
                                    <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                                    <th scope="col" className="px-4 py-3 font-semibold">Joined On</th>
                                    <th scope="col" className="px-4 py-3 font-semibold">Role</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {fetchError && (
                                    <tr>
                                        <td colSpan={4} className="px-4 py-8 text-center text-critical">
                                            {fetchError}
                                        </td>
                                    </tr>
                                )}
                                {loading && (
                                    <tr>
                                        <td colSpan={4} className="px-4 py-8 text-center text-ink-subtle">
                                            Loading accounts...
                                        </td>
                                    </tr>
                                )}
                                {!loading && !fetchError && admins.length === 0 && (
                                    <tr>
                                        <td colSpan={4} className="px-4 py-8 text-center text-ink-subtle">
                                            No accounts found.
                                        </td>
                                    </tr>
                                )}
                                {!loading && !fetchError && admins.map((account) => (
                                    <tr key={account.userId} className="hover:bg-surface-hover">
                                        <td className="px-4 py-3 align-top">
                                            <div className="font-medium">{account.name}</div>
                                            <div className="text-ink-subtle">{account.email}</div>
                                        </td>
                                        <td className="px-4 py-3 align-top">
                                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-label-sm ${account.status === "ACTIVE" ? "bg-verified-bg text-verified" : "bg-border text-ink-muted"}`}>
                                                {account.status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 align-top whitespace-nowrap text-ink-subtle">
                                            {dateFormat.format(new Date(account.createdDate))}
                                        </td>
                                        <td className="px-4 py-3 align-top">
                                            <select
                                                aria-label={`Change role for ${account.name}`}
                                                className={inputClass(false, { extra: "w-auto" })}
                                                value={account.role}
                                                disabled={updatingId === account.userId || account.userId === user?.userId}
                                                onChange={(e) => handleRoleChange(account.userId, e.target.value)}
                                            >
                                                {ALL_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
                                            </select>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </section>
        </div>
    );
}
