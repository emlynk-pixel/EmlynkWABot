import { useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import { createFormShareLink, getFormShareStatus, revokeFormShareLink, type CreatedFormShareLink, type FormShareStatus } from "../../api/candidates";
import { useAuth } from "../../auth/AuthProvider";
import { ActionDialog, DialogError, dangerButton, primaryButton, secondaryButton } from "../Dialog";
import { formatDateTime } from "../format";

// "Share Form": a link that opens the public Candidate Form for THIS
// candidate only. The candidate must still verify with their Passport Number
// and NIC; the form is locked until a link exists, and locked for good once
// they submit (src/services/candidateFormShareService.js).
//
// The link is shown ONCE, right after it is created (only a hash is stored).
// Creating a new link replaces the old one; revoking locks the form again.
export function ShareFormButton({ passportId }: { passportId: string }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button type="button" className={secondaryButton} onClick={() => setOpen(true)}>Share Form</button>
            {open && <ShareFormDialog passportId={passportId} onClose={() => setOpen(false)} />}
        </>
    );
}

const STATE_TEXT: Record<FormShareStatus["state"], string> = {
    LOCKED: "Locked: no active link. The candidate cannot open the form.",
    OPEN: "Open: the candidate can open the form with the link and verify.",
    SUBMITTED: "Submitted: the form is locked and can't be changed or shared again.",
};

function ShareFormDialog({ passportId, onClose }: { passportId: string; onClose: () => void }) {
    const { token } = useAuth();
    const [status, setStatus] = useState<FormShareStatus | null>(null);
    const [created, setCreated] = useState<CreatedFormShareLink | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [confirmRevoke, setConfirmRevoke] = useState(false);

    useEffect(() => {
        if (!token) return undefined;
        const controller = new AbortController();
        getFormShareStatus(token, passportId, controller.signal)
            .then(setStatus)
            .catch((e: unknown) => {
                if ((e as Error)?.name === "AbortError") return;
                setError(e instanceof ApiError ? e.message : "The share status could not be loaded.");
            });
        return () => controller.abort();
    }, [token, passportId]);

    const run = async (action: () => Promise<void>) => {
        if (!token || busy) return;
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
        } finally {
            setBusy(false);
        }
    };
    const create = () => run(async () => {
        const result = await createFormShareLink(token!, passportId);
        setCreated(result);
        setStatus(result.status);
        setCopied(false);
        setConfirmRevoke(false);
    });
    const revoke = () => run(async () => {
        setStatus(await revokeFormShareLink(token!, passportId));
        setCreated(null);
        setConfirmRevoke(false);
    });
    const copy = async () => {
        if (!created) return;
        try {
            await navigator.clipboard.writeText(created.url);
            setCopied(true);
        } catch {
            setError("Copy didn't work in this browser. Select the link and copy it.");
        }
    };

    const whatsappText = created ? encodeURIComponent(`Please fill in your details for Emlynk using this link. You will need your Passport Number and NIC Number.\n${created.url}`) : "";

    return (
        <ActionDialog title="Share the Candidate Form" busy={busy} onClose={onClose}>
            <p className="text-body-sm text-ink-soft">
                The link opens the form for this candidate only. They must verify with their own Passport Number and NIC Number, and can submit once.
            </p>

            {!status && !error && <p role="status" className="mt-3 text-body-sm text-ink-muted">Loading…</p>}
            {status && (
                <div className="mt-3 rounded border border-border bg-canvas px-3 py-2 text-body-sm" role="status">
                    <p className="font-medium text-ink">{STATE_TEXT[status.state]}</p>
                    {status.link && (
                        <p className="mt-1 text-ink-muted">
                            Link created {formatDateTime(status.link.createdAt)}{status.link.createdByName ? ` by ${status.link.createdByName}` : ""}; expires {formatDateTime(status.link.expiresAt)}.
                            {status.link.lockedUntil && ` Locked after too many wrong attempts until ${formatDateTime(status.link.lockedUntil)}.`}
                        </p>
                    )}
                    {status.submittedAt && <p className="mt-1 text-ink-muted">Submitted {formatDateTime(status.submittedAt)}.</p>}
                </div>
            )}

            {created && (
                <div className="mt-3 space-y-2">
                    <label htmlFor="share-link-url" className="block text-label-md text-ink">Share link for this candidate</label>
                    <input id="share-link-url" readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} className="h-9 w-full rounded border border-border-strong bg-surface px-2 text-body-sm text-ink" />
                    <p className="text-label-sm text-ink-muted">
                        Shown only now: if it is lost, create a new link. Send it only to the candidate. Expires {formatDateTime(created.expiresAt)}.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" className={primaryButton} onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
                        <a className={`${secondaryButton} inline-flex items-center`} href={`https://wa.me/?text=${whatsappText}`} target="_blank" rel="noopener noreferrer">Share on WhatsApp</a>
                    </div>
                </div>
            )}

            <DialogError message={error} />

            {status && status.state !== "SUBMITTED" && (
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                    {status.state === "OPEN" && !confirmRevoke && (
                        <button type="button" className={dangerButton} disabled={busy} onClick={() => setConfirmRevoke(true)}>Revoke link</button>
                    )}
                    {confirmRevoke && (
                        <>
                            <span className="self-center text-body-sm text-ink-soft">Revoke the link and lock the form?</span>
                            <button type="button" className={secondaryButton} disabled={busy} onClick={() => setConfirmRevoke(false)}>Keep it</button>
                            <button type="button" className={dangerButton} disabled={busy} onClick={revoke}>Revoke</button>
                        </>
                    )}
                    {!confirmRevoke && (
                        <button type="button" className={primaryButton} disabled={busy} onClick={create}>
                            {busy ? "Working…" : status.state === "OPEN" ? "Create a new link (replaces the current one)" : "Create share link"}
                        </button>
                    )}
                </div>
            )}
            <div className="mt-3 flex justify-end">
                <button type="button" className={secondaryButton} disabled={busy} onClick={onClose}>Close</button>
            </div>
        </ActionDialog>
    );
}
