import { useState, useEffect, type FormEvent } from "react";
import { useNavigate, Link } from "react-router";
import { Icon } from "../components/Icon";
import { authLinkError, getAuthClient } from "../auth/supabaseClient";
import { NewPasswordFields, hasNewPasswordErrors, validateNewPassword, type NewPasswordErrors } from "../components/NewPasswordFields";

const INVALID_LINK = "This password reset link is invalid or has expired. Please request a new link.";

// The Supabase recovery link signs the user in with a recovery session (the
// session arrives in the URL); the new password goes to Supabase Auth
// (updateUser). Afterwards the session is ended and the user signs in again.
export function ResetPasswordPage() {
    const navigate = useNavigate();
    const [linkError] = useState(() => authLinkError());

    const [loading, setLoading] = useState(true);
    const [validationError, setValidationError] = useState<string | null>(null);

    // Form state
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [fieldErrors, setFieldErrors] = useState<NewPasswordErrors>({});
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    useEffect(() => {
        if (linkError) {
            setValidationError(INVALID_LINK);
            setLoading(false);
            return;
        }
        let cancelled = false;
        getAuthClient().getSession()
            .then(({ data }) => { if (!cancelled && !data.session) setValidationError(INVALID_LINK); })
            .catch(() => { if (!cancelled) setValidationError(INVALID_LINK); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => {
            cancelled = true;
        };
    }, [linkError]);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setSubmitError(null);

        const errors = validateNewPassword(password, confirmPassword);
        setFieldErrors(errors);
        if (hasNewPasswordErrors(errors)) {
            document.getElementById(errors.password ? "new-password" : "confirm-password")?.focus();
            return;
        }

        setSubmitting(true);
        try {
            const auth = getAuthClient();
            const { error } = await auth.updateUser({ password });
            if (error) {
                setSubmitError(error.code === "weak_password" ? "Choose a stronger password."
                    : error.code === "same_password" ? "Choose a password different from your current one."
                    : error.status === 401 || error.status === 403 ? INVALID_LINK
                    : "Failed to reset password. Please try again.");
                return;
            }
            // Sign in again with the new password (ends the recovery session everywhere).
            await auth.signOut().catch(() => {});
            setSuccess(true);
        } catch {
            setSubmitError("Failed to reset password. Please try again.");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-12">
            <div className="w-full max-w-sm">
                {/* Brand / Logo */}
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
                    {loading ? (
                        <div className="py-8 text-center text-ink-muted">
                            <Icon name="progress_activity" className="mx-auto size-7 animate-spin text-primary mb-3" />
                            <p className="text-body-sm">Verifying reset link…</p>
                        </div>
                    ) : validationError ? (
                        <div className="text-center py-2">
                            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-critical-bg text-critical">
                                <Icon name="error" className="size-6" />
                            </div>
                            <h2 className="text-headline-sm font-semibold text-ink">Reset Link Problem</h2>
                            <p className="mt-2 text-body-sm text-ink-muted">{validationError}</p>
                            <div className="mt-6 space-y-2">
                                <Link
                                    to="/forgot-password"
                                    className="flex h-9 w-full items-center justify-center rounded bg-primary text-label-md font-medium text-on-primary hover:bg-primary-hover"
                                >
                                    Request New Reset Link
                                </Link>
                                <Link
                                    to="/login"
                                    className="flex h-9 w-full items-center justify-center rounded border border-border bg-surface text-label-md font-medium text-ink hover:bg-canvas-muted"
                                >
                                    Return to Sign In
                                </Link>
                            </div>
                        </div>
                    ) : success ? (
                        <div className="text-center py-2">
                            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-verified-bg text-verified">
                                <Icon name="check_circle" className="size-7" />
                            </div>
                            <h2 className="text-headline-sm font-semibold text-ink">Password Reset Complete</h2>
                            <p className="mt-2 text-body-sm text-ink-muted">
                                Your password has been successfully updated. You can now sign in using your new credentials.
                            </p>
                            <div className="mt-6">
                                <button
                                    type="button"
                                    onClick={() => navigate("/login")}
                                    className="w-full flex h-9 items-center justify-center rounded bg-primary text-label-md font-medium text-on-primary hover:bg-primary-hover shadow-sm"
                                >
                                    Continue to Sign In
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div>
                            <div className="mb-5">
                                <h1 className="text-headline-lg text-ink">Set New Password</h1>
                                <p className="mt-1 text-body-sm text-ink-muted">
                                    Choose a strong password for your account.
                                </p>
                            </div>

                            {submitError && (
                                <div
                                    role="alert"
                                    className="mb-4 flex items-start gap-2 rounded border border-critical-border bg-critical-bg p-3 text-body-sm text-critical"
                                >
                                    <Icon name="error" className="size-4 shrink-0 mt-0.5" />
                                    <span>{submitError}</span>
                                </div>
                            )}

                            <form onSubmit={handleSubmit} className="space-y-5" noValidate>
                                <NewPasswordFields
                                    passwordId="new-password"
                                    password={password}
                                    confirm={confirmPassword}
                                    errors={fieldErrors}
                                    onChange={(next) => {
                                        setPassword(next.password);
                                        setConfirmPassword(next.confirm);
                                        setFieldErrors(next.errors);
                                    }}
                                />

                                <button
                                    type="submit"
                                    disabled={submitting}
                                    className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-label-md text-on-primary hover:bg-primary-hover active:bg-primary-active disabled:cursor-not-allowed disabled:opacity-70"
                                >
                                    {submitting && <Icon name="progress_activity" className="size-4 animate-spin" />}
                                    {submitting ? "Resetting password…" : "Reset password"}
                                </button>
                            </form>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
