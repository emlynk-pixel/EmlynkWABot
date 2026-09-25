import type { ReactNode } from "react";
import { humanize } from "./format";

// Stitch status semantic system: text / tinted background / border.
export type Tone = "verified" | "review" | "pending" | "critical" | "duplicate";

const TONE_CLASSES: Record<Tone, string> = {
    verified: "text-verified bg-verified-bg border-verified-border",
    review: "text-review bg-review-bg border-review-border",
    pending: "text-pending bg-pending-bg border-pending-border",
    critical: "text-critical bg-critical-bg border-critical-border",
    duplicate: "text-duplicate bg-duplicate-bg border-duplicate-border",
};

// Every status code used by documents, submissions and requirements.
const STATUS_TONES: Record<string, Tone> = {
    VERIFIED: "verified",
    HIGH_CONFIDENCE: "verified",
    SLIGHTLY_UNCLEAR: "verified",
    REVIEW_REQUIRED: "review",
    UNCLEAR: "review",
    MANUAL_REVIEW: "review",
    PENDING_REVIEW: "pending",
    UNDEFINED: "pending",
    STORED: "pending",
    TEMPORARY_STORED: "pending",
    MISSING: "critical",
    CONFLICT: "critical",
    FAILED: "critical",
    DUPLICATE: "duplicate",
};

export function statusTone(status: string): Tone {
    return STATUS_TONES[status] ?? "pending";
}

const LABELS: Record<string, string> = {
    REVIEW_REQUIRED: "Review required",
    PENDING_REVIEW: "Pending review",
    HIGH_CONFIDENCE: "High confidence",
    SLIGHTLY_UNCLEAR: "Slightly unclear",
};

export function statusLabel(status: string): string {
    return LABELS[status] ?? humanize(status);
}

// A pill in one of the status tones, with any label.
export function ToneBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
    return (
        <span className={`inline-flex h-[22px] items-center whitespace-nowrap rounded-full border px-2 text-label-sm ${TONE_CLASSES[tone]}`}>
            {children}
        </span>
    );
}

export function StatusBadge({ status }: { status: string }) {
    return <ToneBadge tone={statusTone(status)}>{statusLabel(status)}</ToneBadge>;
}

export function toneDotClass(tone: Tone): string {
    return {
        verified: "bg-verified",
        review: "bg-review",
        pending: "bg-pending",
        critical: "bg-critical",
        duplicate: "bg-duplicate",
    }[tone];
}
