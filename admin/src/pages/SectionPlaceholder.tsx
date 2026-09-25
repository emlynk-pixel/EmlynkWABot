import { Icon } from "../components/Icon";

// Page frame for sections whose data arrives in a later Phase 10 checkpoint.
// Deliberately shows no numbers or sample rows: nothing here is real yet.
export function SectionPlaceholder({ title, description }: { title: string; description: string }) {
    return (
        <section aria-labelledby="page-title">
            <h1 id="page-title" className="text-headline-lg text-ink">{title}</h1>
            <p className="mt-1 text-body-sm text-ink-muted">{description}</p>

            <div className="mt-6 flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong bg-surface px-6 py-16 text-center shadow-surface">
                <Icon name="construction" className="size-8 text-ink-subtle" />
                <p className="mt-3 text-headline-sm text-ink">Not connected yet</p>
                <p className="mt-1 max-w-md text-body-sm text-ink-muted">
                    This section is part of the dashboard shell. Its data will be connected in a later checkpoint.
                </p>
            </div>
        </section>
    );
}
