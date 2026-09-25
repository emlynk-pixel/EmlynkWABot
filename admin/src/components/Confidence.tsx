// OCR confidence (0-100) as stored on the document. Colour follows the
// backend bands: >= 90 high, 60-89 acceptable, 40-59 unclear, < 40 undefined.
export function Confidence({ value }: { value: number | null }) {
    if (value === null) return <span className="text-ink-subtle">—</span>;
    const tone =
        value >= 90 ? "text-verified" : value >= 60 ? "text-ink-soft" : value >= 40 ? "text-review" : "text-critical";
    return <span className={`text-label-sm tabular-nums ${tone}`}>{value.toFixed(1)}%</span>;
}
