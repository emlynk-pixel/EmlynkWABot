import type { ReactNode } from "react";
import { Icon } from "./Icon";

// A flat card: white, with a hairline border and no shadow.
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
    return <div className={`rounded-xl border border-border bg-surface shadow-surface ${className}`}>{children}</div>;
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
            <span className="flex size-11 items-center justify-center rounded-full bg-critical-bg"><Icon name="error" className="size-5 text-critical" /></span>
            <p className="max-w-md text-body-sm text-ink-soft">{message}</p>
            {onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="h-8 rounded-lg border border-border-strong bg-surface px-3 text-label-md text-ink-soft shadow-surface hover:border-border-focus hover:bg-canvas"
                >
                    Try again
                </button>
            )}
        </div>
    );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
    return (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-strong px-6 py-16 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-canvas"><Icon name="description" className="size-5 text-ink-muted" /></span>
            <p className="text-label-md text-ink">{title}</p>
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
