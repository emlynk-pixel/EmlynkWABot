import { useState, useEffect, type FormEvent } from "react";
import { useSearchParams, useNavigate, Link } from "react-router";
import { Icon } from "../components/Icon";
import { validateResetToken, resetPassword } from "../api/auth";
import { ApiError } from "../api/client";
import { NewPasswordFields, hasNewPasswordErrors, validateNewPassword, type NewPasswordErrors } from "../components/NewPasswordFields";

export function ResetPasswordPage() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const token = searchParams.get("token");

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
        if (!token) {
            setValidationError("No password reset token provided. Please check the link in your email.");
            setLoading(false);
            return;
        }

        let cancelled = false;
        async function checkToken() {
            try {
                await validateResetToken(token!);
                if (!cancelled) {
                    setLoading(false);
                }
            } catch (err) {
                if (!cancelled) {
                    setValidationError(
                        err instanceof ApiError
                            ? err.message
                            : "Invalid or expired password reset link. Please request a new link."
                    );
                    setLoading(false);
                }
            }
        }

        checkToken();
        return () => {
            cancelled = true;
        };
    }, [token]);

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
            await resetPassword(token!, password);
            setSuccess(true);
        } catch (err) {
            setSubmitError(
                err instanceof ApiError ? err.message : "Failed to reset password. Please try again."
            );
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
                                    Choose a strong password for your administrator account.
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
