import { Icon } from "../Icon";

// A call the candidate did not answer. An outcome, not an error: the red is
// only the icon and the thin outline (the theme's `critical` tokens, so it
// follows light and dark); the words stay in the normal text colour, and the
// label, not the colour, says what it is. The one look for it wherever calls
// appear (Candidate History, Need Attention).
export function NoAnswerBadge() {
    return (
        <span data-outcome="NO_ANSWER" className="inline-flex items-center gap-1 rounded-full border border-critical-border bg-surface px-2 py-0.5 text-label-sm font-medium text-ink-soft">
            <Icon name="phone_missed" className="size-3.5 text-critical" />
            No Answer
        </span>
    );
}
