import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { submitCandidateForm } from "../api/candidateDetails";
import { ApiError } from "../api/client";
import { idOf, setAt, type StepProps } from "../form/binding";
import { fromPayload, toPayload, type CandidateFormData } from "../form/model";
import { STEPS, stepOf, type StepId } from "../form/steps";
import { BasicStep } from "../form/steps/BasicStep";
import { ContactStep } from "../form/steps/ContactStep";
import { FamilyStep } from "../form/steps/FamilyStep";
import { GuardianStep } from "../form/steps/GuardianStep";
import { MeasurementsStep } from "../form/steps/MeasurementsStep";
import { PassportStep } from "../form/steps/PassportStep";
import { ReviewStep } from "../form/steps/ReviewStep";
import { errorsIn, requiredPaths, validateForm, valueAt, type FieldMessage, type FormErrors } from "../form/validation";
import type { MessageKey } from "../i18n/translations";
import { useLanguage } from "../i18n/useLanguage";
import { getSession } from "../session/tokenStore";
import type { FormLoadResponse } from "../types/api";

// How often the page checks that the in-memory session is still valid.
const SESSION_CHECK_MS = 10_000;

// The server's field codes, as the form's own messages.
const SERVER_CODE: Record<string, MessageKey> = { required: "v.required", tooLong: "v.tooLongShort", invalid: "v.invalidAnswer", unknown: "v.invalidAnswer" };

type SubmitState = "idle" | "confirm" | "sending" | "invalid" | "failed";

// A random key for this form's one submission: a retry after a lost
// response reuses it, so the server can tell it is the same submission.
const newSubmissionKey = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

// The Candidate Form, one section at a time, then a review and ONE submit.
//
// It starts from the server's prefill (the candidate's existing records). The
// answers live only in this component's memory (never in browser storage)
// until they are submitted. After a successful submit the form is locked on
// the server and this page is replaced by a thank-you screen.
export function CandidateFormPage({ expiresAt, form, onSubmitted, onAlreadySubmitted, onSessionEnded }: {
    expiresAt: string;
    form: FormLoadResponse;
    onSubmitted: () => void;
    onAlreadySubmitted: () => void;
    onSessionEnded: () => void;
}) {
    const { t, language } = useLanguage();
    const [data, setData] = useState<CandidateFormData>(() => fromPayload(form.answers));
    const prefilled = useMemo(() => new Set(form.prefilled), [form.prefilled]);
    const [stepIndex, setStepIndex] = useState(0);
    const [furthest, setFurthest] = useState(0);
    // Steps where Next or Submit was tried: their errors are shown, and kept
    // up to date as the candidate corrects them.
    const [attempted, setAttempted] = useState<ReadonlySet<StepId>>(new Set());
    const [serverErrors, setServerErrors] = useState<FormErrors>({});
    const [submitState, setSubmitState] = useState<SubmitState>("idle");
    const submissionKey = useRef(newSubmissionKey());
    const headingRef = useRef<HTMLHeadingElement>(null);
    const firstRender = useRef(true);

    const step = STEPS[stepIndex];
    const allErrors = useMemo(() => ({ ...serverErrors, ...validateForm(data) }), [data, serverErrors]);
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
        setServerErrors((previous) => {
            if (!previous[path]) return previous;
            const { [path]: _removed, ...rest } = previous;
            return rest;
        });
        if (submitState === "invalid" || submitState === "failed") setSubmitState("idle");
    };
    const props: StepProps = { data, set, errors: shownErrors, prefilled };

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

    // Submit: check everything first, then ask for confirmation.
    const askToSubmit = () => {
        setAttempted(new Set(STEPS.map((s) => s.id)));
        setSubmitState(Object.keys(allErrors).length ? "invalid" : "confirm");
    };

    const send = async () => {
        const session = getSession();
        if (!session) {
            onSessionEnded();
            return;
        }
        setSubmitState("sending");
        try {
            await submitCandidateForm(session.token, toPayload(data), submissionKey.current);
            onSubmitted();
        } catch (error) {
            if (error instanceof ApiError && error.status === 409) {
                onAlreadySubmitted();
                return;
            }
            if (error instanceof ApiError && error.status === 401) {
                onSessionEnded();
                return;
            }
            if (error instanceof ApiError && error.status === 400 && error.fieldErrors.length) {
                const mapped: Record<string, FieldMessage> = {};
                for (const fieldError of error.fieldErrors) mapped[fieldError.field] = { key: SERVER_CODE[fieldError.message] ?? "v.invalidAnswer" };
                setServerErrors(mapped);
                setAttempted(new Set(STEPS.map((s) => s.id)));
                setSubmitState("invalid");
                return;
            }
            // Not sent, or the answer was lost: nothing is assumed saved.
            // Trying again reuses the same submission key.
            setSubmitState("failed");
        }
    };

    const stepsWithProblems = STEPS.filter((s) => Object.keys(errorsIn(allErrors, s.groups)).length > 0);
    const currentProblems = Object.keys(errorsIn(shownErrors, step.groups)).length > 0;
    const time = new Date(expiresAt).toLocaleTimeString(language === "si" ? "si-LK" : "en-GB", { hour: "2-digit", minute: "2-digit" });
    const sending = submitState === "sending";

    let content: ReactNode;
    switch (step.id) {
        case "basic": content = <BasicStep {...props} nic={form.identity.nic} />; break;
        case "contact": content = <ContactStep {...props} whatsappNumber={form.identity.whatsappNumber ?? ""} />; break;
        case "passport": content = <PassportStep {...props} passportNumber={form.identity.passportNumber} />; break;
        case "measurements": content = <MeasurementsStep {...props} />; break;
        case "family": content = <FamilyStep {...props} />; break;
        case "guardian": content = <GuardianStep {...props} />; break;
        default: content = <ReviewStep data={data} identity={form.identity} onEdit={(id) => goTo(STEPS.findIndex((s) => s.id === id))} />;
    }

    return (
        <div className="candidate-form">
            <div className="form-intro">
                <p className="success" role="status"><span aria-hidden="true">✓ </span>{t("form.verifiedBanner")}</p>
                <h1>{t("form.title")}</h1>
                <p className="lead">{t("form.intro")}</p>
                {prefilled.size > 0 && <p className="notice subtle">{t("form.prefilledBanner")}</p>}
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
                                    <button type="button" disabled={!reachable || sending} aria-current={current ? "step" : undefined} onClick={() => goTo(index)}>
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
                        {submitState === "invalid" && (
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
                        {submitState === "failed" && (
                            <p className="form-error" role="alert"><span aria-hidden="true">! </span>{t("review.sendFailed")}</p>
                        )}
                        {(submitState === "confirm" || sending) && (
                            <div className="confirm-box" role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-text">
                                <p id="confirm-title" className="confirm-title">{t("review.confirmTitle")}</p>
                                <p id="confirm-text">{t("review.confirmText")}</p>
                                <div className="confirm-actions">
                                    <button type="button" className="primary" disabled={sending} onClick={send}>{sending ? t("review.sending") : t("review.confirmSubmit")}</button>
                                    <button type="button" className="secondary" disabled={sending} onClick={() => setSubmitState("idle")}>{t("review.confirmCancel")}</button>
                                </div>
                            </div>
                        )}
                        <p className="notice subtle">{t("form.notSavedNotice")} {t("form.sessionEnds", { time })}</p>
                    </div>
                )}

                {!(step.id === "review" && (submitState === "confirm" || sending)) && (
                    <div className="step-actions">
                        {step.id === "review"
                            ? <button type="button" className="primary" onClick={askToSubmit}>{submitState === "failed" ? t("review.tryAgain") : t("review.save")}</button>
                            : <button type="button" className="primary" onClick={next}>{t("form.next")}</button>}
                        {stepIndex > 0 && <button type="button" className="secondary" onClick={() => goTo(stepIndex - 1)}>{t("form.previous")}</button>}
                    </div>
                )}
            </section>
        </div>
    );
}
