import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import { forgotPassword } from "../api/auth";
import { Icon } from "../components/Icon";

const MAX_EMAIL_LENGTH = 254;

export function ForgotPasswordPage() {
    const [email, setEmail] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [submitted, setSubmitted] = useState(false);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (submitting) return;
        setError(null);

        const cleanEmail = email.trim();
        if (!cleanEmail) {
            setError("Enter your email address.");
            return;
        }

        setSubmitting(true);
        try {
            await forgotPassword(cleanEmail);
            setSubmitted(true);
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "Something went wrong. Please try again.");
        } finally {
            setSubmitting(false);
        }
    }

    const inputClass =
        "h-9 w-full rounded border border-border-strong bg-surface pl-9 pr-3 text-body-sm text-ink shadow-[inset_0_1px_1px_rgba(15,23,42,0.03)] placeholder:text-ink-subtle focus:border-primary focus:shadow-focus focus:outline-none";

    return (
        <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-12">
            <div className="w-full max-w-sm">
                <div className="mb-6 flex items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-lg bg-sidebar text-headline-sm text-sidebar-text-active">
                        E
                    </span>
                    <div>
                        <p className="text-headline-sm text-ink">EmlynkWABot</p>
                        <p className="text-label-caps uppercase text-ink-subtle">Admin Console</p>
                    </div>
                </div>

                <div className="rounded-lg border border-border bg-surface p-6 shadow-surface">
                    {submitted ? (
                        <div className="text-center py-2">
                            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-verified-bg text-verified">
                                <Icon name="check_circle" className="size-7" />
                            </div>
                            <h1 className="text-headline-sm font-semibold text-ink">Check your email</h1>
                            <p className="mt-2 text-body-sm text-ink-muted leading-relaxed">
                                If an active account matches that email address, a password reset link has been dispatched. Please check your inbox and spam folder.
                            </p>
                            <p className="mt-2 text-label-sm text-ink-subtle">
                                Reset links expire in 1 hour and can only be used once.
                            </p>
                            <div className="mt-6">
                                <Link
                                    to="/login"
                                    className="flex h-9 w-full items-center justify-center rounded bg-primary text-label-md font-medium text-on-primary hover:bg-primary-hover"
                                >
                                    Return to sign in
                                </Link>
                            </div>
                        </div>
                    ) : (
                        <>
                            <h1 className="text-headline-lg text-ink">Reset password</h1>
                            <p className="mt-1 text-body-sm text-ink-muted">
                                Enter your administrator email address and we'll send you a link to reset your password.
                            </p>

                            {error && (
                                <div
                                    role="alert"
                                    className="mt-4 flex items-start gap-2 rounded border border-critical-border bg-critical-bg px-3 py-2 text-body-sm text-critical"
                                >
                                    <Icon name="error" className="mt-px size-4 shrink-0" />
                                    <span>{error}</span>
                                </div>
                            )}

                            <form className="mt-5 space-y-4" onSubmit={handleSubmit} noValidate>
                                <div>
                                    <label htmlFor="email" className="mb-1 block text-label-md text-ink-soft">
                                        Email
                                    </label>
                                    <div className="relative">
                                        <Icon
                                            name="mail"
                                            className="pointer-events-none absolute left-3 top-2.5 size-4 text-ink-subtle"
                                        />
                                        <input
                                            id="email"
                                            name="email"
                                            type="email"
                                            autoComplete="email"
                                            maxLength={MAX_EMAIL_LENGTH}
                                            required
                                            value={email}
                                            onChange={(event) => setEmail(event.target.value)}
                                            className={inputClass}
                                            placeholder="admin@example.com"
                                        />
                                    </div>
                                </div>

                                <button
                                    type="submit"
                                    disabled={submitting}
                                    className="flex h-9 w-full items-center justify-center gap-2 rounded bg-primary px-4 text-label-md text-on-primary hover:bg-primary-hover active:bg-primary-active disabled:cursor-not-allowed disabled:opacity-70"
                                >
                                    {submitting && <Icon name="progress_activity" className="size-4 animate-spin" />}
                                    {submitting ? "Sending reset link…" : "Send reset link"}
                                </button>

                                <div className="text-center pt-2">
                                    <Link
                                        to="/login"
                                        className="text-label-sm font-medium text-primary hover:text-primary-hover hover:underline inline-flex items-center gap-1"
                                    >
                                        <Icon name="chevron_left" className="size-3.5" />
                                        Back to sign in
                                    </Link>
                                </div>
                            </form>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
