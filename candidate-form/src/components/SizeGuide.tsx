import type { ReactNode } from "react";

// A compact size guide, always shown under its size field (no link to open it, so a candidate never
// has to find it), fitting a phone. It is a reference only: it never sets or changes the answer.
export function SizeGuide({ id, title, children }: { id: string; title: string; children: ReactNode }) {
    return (
        <section id={id} className="size-guide size-guide-panel" aria-label={title}>
            <p className="size-guide-title">{title}</p>
            {children}
        </section>
    );
}
