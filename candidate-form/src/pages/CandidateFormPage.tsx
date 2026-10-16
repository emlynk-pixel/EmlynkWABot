import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { idOf, setAt, type StepProps } from "../form/binding";
import { emptyForm, type CandidateFormData } from "../form/model";
import { STEPS, stepOf, type StepId } from "../form/steps";
import { BasicStep } from "../form/steps/BasicStep";
import { ContactStep } from "../form/steps/ContactStep";
import { FamilyStep } from "../form/steps/FamilyStep";
import { GuardianStep } from "../form/steps/GuardianStep";
import { MeasurementsStep } from "../form/steps/MeasurementsStep";
import { PassportStep } from "../form/steps/PassportStep";
import { ReviewStep } from "../form/steps/ReviewStep";
import { errorsIn, requiredPaths, validateForm, valueAt, type FormErrors } from "../form/validation";
import { useLanguage } from "../i18n/useLanguage";
import { getSession, type VerifiedIdentity } from "../session/tokenStore";

// How often the page checks that the in-memory session is still valid.
const SESSION_CHECK_MS = 10_000;

type SaveOutcome = "notConnected" | "invalid" | null;

// The Candidate Form, one section at a time, then a review.
//
// The answers live only in this component's memory (never in browser
// storage) and are gone when the page is left, like the session itself.
// Saving is Task 3: until the secure save exists, "Save Details" checks the
// answers and then says plainly that saving is not connected yet. It sends
// nothing.
export function CandidateFormPage({ expiresAt, identity, onFinish, onSessionEnded }: {
    expiresAt: string;
    identity: VerifiedIdentity;
    onFinish: () => void;
    onSessionEnded: () => void;
}) {
    const { t, language } = useLanguage();
    const [data, setData] = useState<CandidateFormData>(emptyForm);
    const [stepIndex, setStepIndex] = useState(0);
    const [furthest, setFurthest] = useState(0);
    // Steps where Next or Save was tried: their errors are shown, and kept
    // up to date as the candidate corrects them.
    const [attempted, setAttempted] = useState<ReadonlySet<StepId>>(new Set());
    const [saveOutcome, setSaveOutcome] = useState<SaveOutcome>(null);
    const headingRef = useRef<HTMLHeadingElement>(null);
    const firstRender = useRef(true);

    const step = STEPS[stepIndex];
    const allErrors = useMemo(() => validateForm(data), [data]);
    const shownErrors: FormErrors = useMemo(
        () => Object.fromEntries(Object.entries(allErrors).filter(([path]) => {
            const owner = stepOf(path);
            return owner !== undefined && attempted.has(owner.id);
        })),
        [allErrors, attempted],
    );
    const required = requiredPaths(data);
    const done = required.filter((path) => valueAt(data, path).trim() !== "" && !allErrors[path]).length;

    // The token is only in memory: once it is gone (expired, or the page was
    // reloaded) the candidate goes back to verification.
    useEffect(() => {
        if (!getSession()) {
            onSessionEnded();
            return undefined;
        }
        const timer = window.setInterval(() => {
            if (!getSession()) onSessionEnded();
        }, SESSION_CHECK_MS);
        return () => window.clearInterval(timer);
    }, [onSessionEnded]);

    // A new step starts at its heading (screen readers and keyboards land there).
    useEffect(() => {
        if (firstRender.current) {
            firstRender.current = false;
            return;
        }
        headingRef.current?.focus();
        headingRef.current?.scrollIntoView?.({ block: "start" });
    }, [stepIndex]);

    const set = (path: string) => (value: string) => {
        setData((previous) => setAt(previous, path, value));
        setSaveOutcome(null);
    };
    const props: StepProps = { data, set, errors: shownErrors };

    const goTo = (index: number) => {
        setStepIndex(index);
        setFurthest((previous) => Math.max(previous, index));
    };
    const focusFirstError = (errors: FormErrors) => {
        const first = Object.keys(errors)[0];
        if (!first) return;
        window.requestAnimationFrame(() => {
            const id = idOf(first);
            (document.getElementById(`${id}Other`) ?? document.getElementById(id))?.focus();
        });
    };

    const next = () => {
        const problems = errorsIn(allErrors, step.groups);
        setAttempted((previous) => new Set(previous).add(step.id));
        if (Object.keys(problems).length) {
            focusFirstError(problems);
            return;
        }
        goTo(stepIndex + 1);
    };

    const save = () => {
        setAttempted(new Set(STEPS.map((s) => s.id)));
        setSaveOutcome(Object.keys(allErrors).length ? "invalid" : "notConnected");
    };

    const stepsWithProblems = STEPS.filter((s) => Object.keys(errorsIn(allErrors, s.groups)).length > 0);
    const currentProblems = Object.keys(errorsIn(shownErrors, step.groups)).length > 0;
    const time = new Date(expiresAt).toLocaleTimeString(language === "si" ? "si-LK" : "en-GB", { hour: "2-digit", minute: "2-digit" });

    let content: ReactNode;
    switch (step.id) {
        case "basic": content = <BasicStep {...props} />; break;
        case "contact": content = <ContactStep {...props} whatsappNumber={identity.whatsappNumber} />; break;
        case "passport": content = <PassportStep {...props} passportNumber={identity.passportNumber} />; break;
        case "measurements": content = <MeasurementsStep {...props} />; break;
        case "family": content = <FamilyStep {...props} />; break;
        case "guardian": content = <GuardianStep {...props} />; break;
        default: content = <ReviewStep data={data} identity={identity} onEdit={(id) => goTo(STEPS.findIndex((s) => s.id === id))} />;
    }

    return (
        <div className="candidate-form">
            <div className="form-intro">
                <p className="success" role="status"><span aria-hidden="true">✓ </span>{t("form.verifiedBanner")}</p>
                <h1>{t("form.title")}</h1>
                <p className="lead">{t("form.intro")}</p>
            </div>

            <div className="progress-block">
                <div className="progress-text">
                    <span className="progress-step">{t("form.stepOf", { current: stepIndex + 1, total: STEPS.length })}</span>
                    <span className="progress-done">{t("form.requiredDone", { done, total: required.length })}</span>
                </div>
                <progress value={done} max={required.length} aria-label={t("form.requiredDone", { done, total: required.length })} />
                <nav aria-label={t("form.sections")}>
                    <ol className="step-list">
                        {STEPS.map((s, index) => {
                            const reachable = index <= furthest;
                            const current = index === stepIndex;
                            return (
                                <li key={s.id} className={current ? "current" : index < stepIndex ? "done" : undefined}>
                                    <button type="button" disabled={!reachable} aria-current={current ? "step" : undefined} onClick={() => goTo(index)}>
                                        <span className="step-number" aria-hidden="true">{index + 1}</span>
                                        <span className="step-name">{t(s.title)}</span>
                                    </button>
                                </li>
                            );
                        })}
                    </ol>
                </nav>
            </div>

            <section className="panel step-panel" aria-labelledby="step-title">
                <header className="step-head">
                    <h2 id="step-title" ref={headingRef} tabIndex={-1}>
                        {t(step.title)}
                        {step.important && <span className="badge">{t("form.important")}</span>}
                    </h2>
                    <p className="lead">{t(step.lead)}</p>
                </header>

                {content}

                {currentProblems && step.id !== "review" && (
                    <p className="form-error" role="alert"><span aria-hidden="true">! </span>{t("form.fixErrors")}</p>
                )}

                {step.id === "review" && (
                    <div className="save-area">
                        {saveOutcome === "invalid" && (
                            <div className="form-error" role="alert">
                                <p><span aria-hidden="true">! </span>{t("review.problems")}</p>
                                <ul>
                                    {stepsWithProblems.map((s) => (
                                        <li key={s.id}>
                                            <button type="button" className="link-button" onClick={() => goTo(STEPS.indexOf(s))}>{t("review.goTo", { section: t(s.title) })}</button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        {saveOutcome === "notConnected" && (
                            <div className="notice" role="status">
                                <p><strong>{t("review.devNotice")}</strong></p>
                                <p>{t("review.notSaved")}</p>
                            </div>
                        )}
                        <p className="notice subtle">{t("form.notSavedNotice")} {t("form.sessionEnds", { time })}</p>
                    </div>
                )}

                <div className="step-actions">
                    {step.id === "review"
                        ? <button type="button" className="primary" onClick={save}>{t("review.save")}</button>
                        : <button type="button" className="primary" onClick={next}>{t("form.next")}</button>}
                    {stepIndex > 0 && <button type="button" className="secondary" onClick={() => goTo(stepIndex - 1)}>{t("form.previous")}</button>}
                    {step.id === "review" && <button type="button" className="secondary" onClick={onFinish}>{t("form.finish")}</button>}
                </div>
            </section>
        </div>
    );
}
