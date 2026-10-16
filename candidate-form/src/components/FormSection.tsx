import { useId, type ReactNode } from "react";

// One group of the form: a heading, an optional one-line note, its fields.
export function FormSection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
    const headingId = useId();
    return (
        <section className="form-section" aria-labelledby={headingId}>
            <h2 id={headingId}>{title}</h2>
            {note && <p className="section-note">{note}</p>}
            <div className="section-fields">{children}</div>
        </section>
    );
}
