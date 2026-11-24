import { useState, type ReactNode } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { ApiError } from "../../api/client";
import { getVisaSubmissionFile, getVisaSubmissionManifest, recordVisaSubmissionDownload, type VisaSubmissionManifest } from "../../api/candidates";
import { ConfirmDialog } from "../ConfirmDialog";
import { secondaryButton } from "../Dialog";
import { Icon } from "../Icon";
import { VisaMergeError, mergeVisaSubmission, saveVisaSubmissionPdf, verifiedSlots, visaSubmissionFileName, type MergeProgress } from "../../utils/visaSubmissionMerge";

export const NO_VERIFIED_DOCUMENT = "None of the visa submission documents is verified yet, so there is nothing to download.";

// The slots that will be left out, as the manifest orders them: "Medical (missing)".
const gapsOf = (manifest: VisaSubmissionManifest) =>
    [...manifest.slots]
        .sort((a, b) => a.order - b.order)
        .filter((slot) => slot.status !== "VERIFIED")
        .map((slot) => `${slot.label} (${slot.status === "MISSING" ? "missing" : "not verified"})`);

const apiMessage = (caught: unknown, fallback: string) => (caught instanceof ApiError ? caught.message : fallback);

// Download of the unsigned Visa Submission file (roles.ts VISA_SUBMISSION_ROLES; the server checks
// every request): the manifest, a confirmation when a document will be left out, the merge in this
// browser, the audit entry, then the save. The merged file is never uploaded or stored.
// `button` sits beside the document's Upload; `panel` (progress, errors, the dialog) below the row.
export function useVisaSubmissionDownload(passportId: string): { button: ReactNode; panel: ReactNode } {
    const { token } = useAuth();
    const [phase, setPhase] = useState<"idle" | "checking" | "merging" | "recording">("idle");
    const [progress, setProgress] = useState<MergeProgress | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<VisaSubmissionManifest | null>(null);
    const busy = phase !== "idle";

    const build = async (manifest: VisaSubmissionManifest) => {
        if (!token) return;
        setConfirming(null);
        setPhase("merging");
        try {
            const { bytes, includedSlots } = await mergeVisaSubmission(
                manifest.slots,
                (slot) => getVisaSubmissionFile(token, passportId, slot.document!.documentId),
                setProgress,
            );
            setPhase("recording");
            try {
                await recordVisaSubmissionDownload(token, passportId, includedSlots);
            } catch (caught) {
                if (caught instanceof ApiError && caught.code === "SLOT_NOT_VERIFIED") {
                    const fresh = await getVisaSubmissionManifest(token, passportId).catch(() => null);
                    const gaps = fresh ? gapsOf(fresh) : [];
                    setError(`The documents changed while the file was being prepared${gaps.length ? ` (now: ${gaps.join(", ")})` : ""}. Nothing was downloaded. Click Download to try again.`);
                } else {
                    // The download is audited: without the entry, the file is not saved.
                    setError(`The download could not be recorded, so the file was not saved. ${apiMessage(caught, "Please try again.")}`);
                }
                return;
            }
            const fileName = visaSubmissionFileName(passportId);
            saveVisaSubmissionPdf(bytes, fileName);
            setDone(`Downloaded ${fileName}`);
        } catch (caught) {
            setError(caught instanceof VisaMergeError ? `${caught.message} Nothing was downloaded.` : "The visa submission file could not be prepared. Nothing was downloaded.");
        } finally {
            setPhase("idle");
            setProgress(null);
        }
    };

    const start = async () => {
        if (!token || busy) return;
        setError(null);
        setDone(null);
        setPhase("checking");
        let manifest: VisaSubmissionManifest;
        try {
            manifest = await getVisaSubmissionManifest(token, passportId);
        } catch (caught) {
            setError(apiMessage(caught, "The visa submission documents could not be loaded."));
            setPhase("idle");
            return;
        }
        if (verifiedSlots(manifest.slots).length === 0) {
            setError(NO_VERIFIED_DOCUMENT);
            setPhase("idle");
            return;
        }
        if (gapsOf(manifest).length > 0) {
            setConfirming(manifest);
            setPhase("idle");
            return;
        }
        await build(manifest);
    };

    const button = (
        <button type="button" disabled={busy} onClick={start} className={`${secondaryButton} inline-flex items-center gap-1.5`}>
            <Icon name="picture_as_pdf" className="size-4" />{busy ? "Preparing…" : "Download"}
        </button>
    );

    const panel = (
        <>
            {phase === "merging" || phase === "recording" ? (
                <div role="status" className="mt-2 rounded-lg border border-review-border bg-review-bg px-3 py-2 text-label-sm text-review">
                    <p>{progress ? `Preparing document ${progress.current}/${progress.total}…` : "Preparing…"}</p>
                    <p className="font-medium">Do not close this tab until the download starts.</p>
                </div>
            ) : done ? (
                <p role="status" className="mt-2 inline-flex items-center gap-1 text-label-sm text-verified"><Icon name="check" className="size-3.5" />{done}</p>
            ) : null}
            {error && <p role="alert" className="mt-2 text-label-sm text-critical">{error}</p>}
            {confirming && (
                <ConfirmDialog
                    title="Download with documents left out?"
                    variant="warning"
                    confirmLabel="Download anyway"
                    onConfirm={() => { void build(confirming); }}
                    onCancel={() => setConfirming(null)}
                >
                    <p>These documents are missing or not verified, and will be left out of the file:</p>
                    <ul className="mt-2 list-disc pl-5" aria-label="Documents left out">
                        {gapsOf(confirming).map((gap) => <li key={gap}>{gap}</li>)}
                    </ul>
                </ConfirmDialog>
            )}
        </>
    );

    return { button, panel };
}
