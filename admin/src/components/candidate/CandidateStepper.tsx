import { STAGE_LABELS, type StageProgress } from "../../api/candidates";
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
    incomplete: "border-2 border-critical bg-stepper-white text-critical",
    complete: "border-2 border-verified bg-stepper-white text-verified",
    "complete-out-of-order": "border-2 border-verified bg-stepper-white text-verified",
};

// The selected stage is filled in (colours inverted), so it stands out from the others.
const ACTIVE_CIRCLE: Record<StepTone, string> = {
    incomplete: "border-2 border-critical bg-critical text-stepper-white",
    complete: "border-2 border-verified bg-verified text-stepper-white",
    "complete-out-of-order": "border-2 border-verified bg-verified text-stepper-white",
};

const TONE_LABEL: Record<StepTone, string> = {
    incomplete: "incomplete",
    complete: "completed",
    "complete-out-of-order": "completed out of order",
};

// One circle of the progress stepper: a deployment stage, or another
// section of the candidate page (Additional details).
export type StepperStep = { key: string; label: string; completed: boolean };

// The candidate's progress steps (chosen by the page). Every step can be opened at any time.
export function CandidateStepper({ steps, current, onSelect }: { steps: StepperStep[]; current: string | null; onSelect: (key: string) => void }) {
    const tones = stepTones(steps);
    return (
        <nav aria-label="Deployment stages">
            <ol className="flex items-start">
                {steps.map((stage, index) => {
                    const active = stage.key === current;
                    const tone = tones[index];
                    const circle = active ? ACTIVE_CIRCLE[tone] : CIRCLE[tone];
                    return (
                        <li key={stage.key} className="relative flex flex-1 flex-col items-center">
                            {index > 0 && <span aria-hidden="true" className="absolute top-4 right-1/2 h-px w-full bg-border" />}
                            <button
                                type="button"
                                onClick={() => onSelect(stage.key)}
                                aria-current={active ? "step" : undefined}
                                aria-label={`${index + 1}. ${stage.label} (${TONE_LABEL[tone]})`}
                                className="group relative z-10 flex flex-col items-center gap-2 px-1 focus:outline-none"
                            >
                                <span className={`flex size-8 items-center justify-center rounded-full text-label-md tabular-nums ${circle} group-focus-visible:shadow-focus`}>
                                    {stage.completed ? <Icon name="check" className="size-4" /> : <span aria-hidden="true" className="font-bold">!</span>}
                                </span>
                                <span className={`text-center text-label-sm ${active ? "font-semibold text-ink" : "text-ink-muted"}`}>{stage.label}</span>
                            </button>
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}

// Candidate list: the stage the candidate is at (the first one not completed)
// and how many of the six are completed.
export function StageSummary({ stages }: { stages: StageProgress[] }) {
    const done = stages.filter((s) => s.completed).length;
    const current = stages.find((s) => !s.completed);
    return (
        <span className="block" aria-label={`${current ? STAGE_LABELS[current.stage] : "All stages completed"}, ${done} of ${stages.length} stages completed`}>
            <span className="block text-label-sm lowercase text-ink-subtle">{current ? STAGE_LABELS[current.stage] : "completed"}</span>
            <span className="block text-body-sm tabular-nums">
                <span className={done === stages.length ? "text-verified" : "text-primary"}>{done}</span>
                <span className="text-ink-subtle">/{stages.length}</span>
            </span>
        </span>
    );
}
