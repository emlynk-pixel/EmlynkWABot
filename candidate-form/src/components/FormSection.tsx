import { useId, type ReactNode } from "react";

// One group of the form: a heading (below a step section's own heading), an optional one-line note, its fields.
export function FormSection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
    const headingId = useId();
    return (
        <section className="form-section" aria-labelledby={headingId}>
            <h4 id={headingId}>{title}</h4>
            {note && <p className="section-note">{note}</p>}
            <div className="section-fields">{children}</div>
        </section>
    );
}
