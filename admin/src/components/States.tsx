import type { ReactNode } from "react";
import { Icon } from "./Icon";

// Surface layer 1 (Stitch): white card, hairline border, micro-shadow.
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
    return <div className={`rounded-lg border border-border bg-surface shadow-surface ${className}`}>{children}</div>;
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
    return (
        <div role="status" aria-live="polite" className="flex items-center justify-center gap-3 py-12 text-body-sm text-ink-muted">
            <Icon name="progress_activity" className="size-5 animate-spin text-primary" />
            {label}
        </div>
    );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
            <Icon name="error" className="size-7 text-critical" />
            <p className="max-w-md text-body-sm text-ink-soft">{message}</p>
            {onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="h-8 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft shadow-surface hover:border-border-focus hover:bg-canvas"
                >
                    Try again
                </button>
            )}
        </div>
    );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
    return (
        <div className="flex flex-col items-center gap-2 py-12 text-center">
            <Icon name="description" className="size-7 text-ink-subtle" />
            <p className="text-headline-sm text-ink">{title}</p>
            {description && <p className="max-w-md text-body-sm text-ink-muted">{description}</p>}
            {action}
        </div>
    );
}

export function SectionHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-3">
            <div>
                <h2 className="text-headline-md text-ink">{title}</h2>
                {description && <p className="mt-0.5 text-body-sm text-ink-muted">{description}</p>}
            </div>
            {action}
        </div>
    );
}
