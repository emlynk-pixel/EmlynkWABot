import { STAGE_LABELS, type CandidateStageKey, type StageProgress } from "../../api/candidates";
import { Icon } from "../Icon";

// incomplete: red. complete: green. complete-out-of-order: light green — a
// completed stage with an incomplete stage before it. Once every earlier
// stage is completed it shows as plain green.
export type StepTone = "incomplete" | "complete" | "complete-out-of-order";

export function stepTones(stages: { completed: boolean }[]): StepTone[] {
    let earlierAllComplete = true;
    return stages.map((stage) => {
        const tone: StepTone = !stage.completed ? "incomplete" : earlierAllComplete ? "complete" : "complete-out-of-order";
        if (!stage.completed) earlierAllComplete = false;
        return tone;
    });
}

const CIRCLE: Record<StepTone, string> = {
    incomplete: "bg-critical text-on-critical",
    complete: "bg-verified text-surface",
    "complete-out-of-order": "border border-verified bg-verified-bg text-verified",
};

const TONE_LABEL: Record<StepTone, string> = {
    incomplete: "incomplete",
    complete: "completed",
    "complete-out-of-order": "completed out of order",
};

// The six deployment stages. Every stage can be opened at any time.
export function CandidateStepper({ stages, current, onSelect }: { stages: StageProgress[]; current: CandidateStageKey; onSelect: (stage: CandidateStageKey) => void }) {
    const tones = stepTones(stages);
    return (
        <nav aria-label="Deployment stages">
            <ol className="flex items-start">
                {stages.map((stage, index) => {
                    const active = stage.stage === current;
                    const tone = tones[index];
                    return (
                        <li key={stage.stage} className="relative flex flex-1 flex-col items-center">
                            {index > 0 && <span aria-hidden="true" className="absolute top-4 right-1/2 h-px w-full bg-border" />}
                            <button
                                type="button"
                                onClick={() => onSelect(stage.stage)}
                                aria-current={active ? "step" : undefined}
                                aria-label={`${index + 1}. ${STAGE_LABELS[stage.stage]} (${TONE_LABEL[tone]})`}
                                className="group relative z-10 flex flex-col items-center gap-2 px-1 focus:outline-none"
                            >
                                <span className={`flex size-8 items-center justify-center rounded-full text-label-md tabular-nums ${CIRCLE[tone]} ${active ? "ring-2 ring-primary ring-offset-2 ring-offset-surface" : ""} group-focus-visible:shadow-focus`}>
                                    {stage.completed ? <Icon name="check" className="size-4" /> : index + 1}
                                </span>
                                <span className={`text-center text-label-sm ${active ? "font-semibold text-ink" : "text-ink-muted"}`}>{STAGE_LABELS[stage.stage]}</span>
                            </button>
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}

// The same six states as small dots (candidate list).
export function StageDots({ stages }: { stages: StageProgress[] }) {
    const tones = stepTones(stages);
    const done = stages.filter((s) => s.completed).length;
    return (
        <span className="inline-flex items-center gap-1" role="img" aria-label={`${done} of ${stages.length} stages completed`}>
            {stages.map((stage, index) => (
                <span key={stage.stage} title={`${STAGE_LABELS[stage.stage]}: ${TONE_LABEL[tones[index]]}`} className={`size-2.5 rounded-full ${CIRCLE[tones[index]]}`} />
            ))}
        </span>
    );
}
