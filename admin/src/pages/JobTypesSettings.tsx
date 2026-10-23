import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { createJobType, listJobTypes, updateJobType, type ManagedJobType } from "../api/jobs";
import { useAdminResource } from "../api/useAdminResource";
import { useAuth } from "../auth/AuthProvider";
import { primaryButton, secondaryButton } from "../components/Dialog";
import { Card, ErrorState, LoadingState, SectionHeading } from "../components/States";
import { ToneBadge } from "../components/StatusBadge";
import { filterControl, tableCell, tableHead } from "../components/ui";

const message = (caught: unknown) => (caught instanceof ApiError ? caught.message : "Something went wrong. Please try again.");

// Settings > Job Types (ADMIN only, like every Settings tab; the server checks
// it too). The managed list behind every job type choice: new Jobs, the
// candidate pickers (registration, Candidate Details) and the Candidate Form.
//   - Add a type; rename it (its Jobs follow; candidates keep the text they saved).
//   - Deactivate instead of delete: an inactive type is no longer offered for new
//     choices, while every Job and candidate that has it keeps it.
//   - "No Preferred Type" is a system option for candidates (never a Job's type):
//     always available, and it cannot be renamed, deactivated or deleted.
export function JobTypesSettings() {
    const { token } = useAuth();
    const list = useAdminResource("settings-job-types", (t, signal) => listJobTypes(t, signal));
    const [name, setName] = useState("");
    const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

    const run = async (work: () => Promise<string>) => {
        if (!token) return;
        setBusy(true);
        setNotice(null);
        try {
            setNotice({ tone: "ok", text: await work() });
            list.reload();
            return true;
        } catch (caught) {
            setNotice({ tone: "error", text: message(caught) });
            return false;
        } finally {
            setBusy(false);
        }
    };
    const add = async (event: FormEvent) => {
        event.preventDefault();
        if (!token || !name.trim()) return;
        if (await run(async () => `Added "${(await createJobType(token, name.trim())).name}".`)) setName("");
    };
    const rename = async (event: FormEvent, row: ManagedJobType) => {
        event.preventDefault();
        if (!token || !editing) return;
        if (await run(async () => `Renamed to "${(await updateJobType(token, row.id, { name: editing.name.trim() })).name}".`)) setEditing(null);
    };
    const setActive = (row: ManagedJobType, isActive: boolean) => run(async () => {
        await updateJobType(token!, row.id, { isActive });
        return isActive ? `"${row.name}" is active again.` : `"${row.name}" is inactive: no longer offered for new choices. Existing jobs and candidates keep it.`;
    });

    return (
        <Card className="p-6">
            <SectionHeading
                title="Job Types"
                description="The job types offered when creating a job, registering a candidate and in the Candidate Form. Deactivate a type instead of deleting it: jobs and candidates that already have it keep it."
            />
            <form onSubmit={add} className="mt-5 flex flex-wrap items-end gap-2">
                <div className="min-w-[14rem] flex-1">
                    <label htmlFor="new-job-type" className="mb-1 block text-label-sm text-ink-muted">New job type</label>
                    <input id="new-job-type" value={name} maxLength={120} disabled={busy} onChange={(event) => setName(event.target.value)} placeholder="e.g. Scaffolder" className={filterControl} />
                </div>
                <button type="submit" className={primaryButton} disabled={busy || !name.trim()}>Add job type</button>
            </form>
            {notice && (
                <p role={notice.tone === "error" ? "alert" : "status"} className={`mt-3 text-body-sm ${notice.tone === "error" ? "text-critical" : "text-ink-muted"}`}>{notice.text}</p>
            )}

            <div className="mt-5">
                {list.status === "loading" && !list.data && <LoadingState label="Loading job types…" />}
                {list.status === "error" && <ErrorState message={list.error.message} onRetry={list.reload} />}
                {list.data && (
                    <div className="overflow-x-auto rounded border border-border">
                        <table className="w-full" aria-label="Job types">
                            <thead>
                                <tr>
                                    <th scope="col" className={tableHead}>Job type</th>
                                    <th scope="col" className={tableHead}>Status</th>
                                    <th scope="col" className={tableHead}>Jobs</th>
                                    <th scope="col" className={`${tableHead} text-right`}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td className={tableCell}>
                                        <span className="font-medium text-ink">{list.data.noPreference.label}</span>
                                        <span className="ml-2 text-label-sm text-ink-muted">For candidates: any job type</span>
                                    </td>
                                    <td className={tableCell}><ToneBadge tone="pending">System</ToneBadge></td>
                                    <td className={`${tableCell} text-ink-muted`}>—</td>
                                    <td className={`${tableCell} text-right text-label-sm text-ink-muted`}>Always available</td>
                                </tr>
                                {list.data.items.map((row) => (
                                    <tr key={row.id}>
                                        <td className={tableCell}>
                                            {editing?.id === row.id ? (
                                                <form onSubmit={(event) => void rename(event, row)} className="flex items-center gap-2">
                                                    <label htmlFor={`rename-${row.id}`} className="sr-only">New name for {row.name}</label>
                                                    <input id={`rename-${row.id}`} value={editing.name} maxLength={120} disabled={busy} autoFocus onChange={(event) => setEditing({ id: row.id, name: event.target.value })} className={filterControl} />
                                                    <button type="submit" className={primaryButton} disabled={busy || !editing.name.trim()}>Save</button>
                                                    <button type="button" className={secondaryButton} disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
                                                </form>
                                            ) : (
                                                <span className={row.isActive ? "text-ink" : "text-ink-muted"}>{row.name}</span>
                                            )}
                                        </td>
                                        <td className={tableCell}>{row.isActive ? <ToneBadge tone="verified">Active</ToneBadge> : <ToneBadge tone="duplicate">Inactive</ToneBadge>}</td>
                                        <td className={`${tableCell} tabular-nums`}>{row.jobCount}</td>
                                        <td className={`${tableCell} text-right`}>
                                            {editing?.id !== row.id && (
                                                <span className="inline-flex gap-2">
                                                    <button type="button" className={secondaryButton} disabled={busy} onClick={() => setEditing({ id: row.id, name: row.name })} aria-label={`Rename ${row.name}`}>Rename</button>
                                                    {row.isActive
                                                        ? <button type="button" className={secondaryButton} disabled={busy} onClick={() => void setActive(row, false)} aria-label={`Deactivate ${row.name}`}>Deactivate</button>
                                                        : <button type="button" className={secondaryButton} disabled={busy} onClick={() => void setActive(row, true)} aria-label={`Activate ${row.name}`}>Activate</button>}
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </Card>
    );
}
