import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { appUrl, getAuthClient } from "../auth/supabaseClient";
import { Icon } from "../components/Icon";
import { FormField, fieldA11y } from "../components/Form";
import { inputClass } from "../components/ui";
import { MAX_EMAIL_LENGTH, emailError } from "../components/validation";

export function ForgotPasswordPage() {
    const [email, setEmail] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [submitted, setSubmitted] = useState(false);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (submitting) return;
        setError(null);

        const invalid = emailError(email);
        setFieldError(invalid);
        if (invalid) {
            document.getElementById("email")?.focus();
            return;
        }
        const cleanEmail = email.trim();

        // Supabase Auth sends the recovery email. Its answer is the same
        // whether or not the address has an account, and so is this page's:
        // only a rate limit or an unreachable service is reported.
        setSubmitting(true);
        try {
            const { error: sendError } = await getAuthClient().resetPasswordForEmail(cleanEmail, { redirectTo: appUrl("reset-password") });
            if (sendError?.status === 429) setError("Too many password reset requests. Please try again later.");
            else if (sendError && !sendError.status) setError("Cannot reach the server. Check your connection and try again.");
            else setSubmitted(true);
        } catch {
            setError("Something went wrong. Please try again.");
        } finally {
            setSubmitting(false);
        }
    }

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
                                If an account matches that email address, a password reset link has been sent. Please check your inbox and spam folder.
                            </p>
                            <p className="mt-2 text-label-sm text-ink-subtle">
                                Reset links expire and can only be used once.
                            </p>
                            <div className="mt-6">
                                <Link
                                    to="/login"
                                    className="flex h-10 w-full items-center justify-center rounded-md bg-primary text-label-md font-medium text-on-primary hover:bg-primary-hover"
                                >
                                    Return to sign in
                                </Link>
                            </div>
                        </div>
                    ) : (
                        <>
                            <h1 className="text-headline-lg text-ink">Reset password</h1>
                            <p className="mt-1 text-body-sm text-ink-muted">
                                Enter your account's email address and we'll send you a link to reset your password.
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

                            <form className="mt-6 space-y-5" onSubmit={handleSubmit} noValidate>
                                <FormField id="email" label="Email" required help="The email address you sign in with." error={fieldError}>
                                    <div className="relative">
                                        <Icon name="mail" className="pointer-events-none absolute left-3 top-3 size-4 text-ink-subtle" />
                                        <input
                                            {...fieldA11y("email", fieldError)}
                                            name="email"
                                            type="email"
                                            autoComplete="email"
                                            maxLength={MAX_EMAIL_LENGTH}
                                            required
                                            value={email}
                                            onChange={(event) => {
                                                setEmail(event.target.value);
                                                if (fieldError) setFieldError(emailError(event.target.value));
                                            }}
                                            className={inputClass(Boolean(fieldError), { padding: "pl-9 pr-3" })}
                                            placeholder="admin@example.com"
                                        />
                                    </div>
                                </FormField>

                                <button
                                    type="submit"
                                    disabled={submitting}
                                    className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-label-md text-on-primary hover:bg-primary-hover active:bg-primary-active disabled:cursor-not-allowed disabled:opacity-70"
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
