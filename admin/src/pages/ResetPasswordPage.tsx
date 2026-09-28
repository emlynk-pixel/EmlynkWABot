import { useState, useEffect, type FormEvent } from "react";
import { useSearchParams, useNavigate, Link } from "react-router";
import { Icon } from "../components/Icon";
import { validateResetToken, resetPassword } from "../api/auth";
import { ApiError } from "../api/client";

export function ResetPasswordPage() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const token = searchParams.get("token");

    const [loading, setLoading] = useState(true);
    const [validationError, setValidationError] = useState<string | null>(null);

    // Form state
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
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

        if (password.length < 8) {
            setSubmitError("Password must be at least 8 characters long.");
            return;
        }

        if (password !== confirmPassword) {
            setSubmitError("Passwords do not match.");
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

    const inputClass =
        "h-9 w-full rounded border border-border-strong bg-surface pl-9 pr-10 text-body-sm text-ink shadow-[inset_0_1px_1px_rgba(15,23,42,0.03)] placeholder:text-ink-subtle focus:border-primary focus:shadow-focus focus:outline-none";

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

                            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                                <div>
                                    <label htmlFor="new-password" className="mb-1 block text-label-md text-ink-soft">
                                        New Password
                                    </label>
                                    <div className="relative">
                                        <Icon
                                            name="lock"
                                            className="pointer-events-none absolute left-3 top-2.5 size-4 text-ink-subtle"
                                        />
                                        <input
                                            id="new-password"
                                            type={showPassword ? "text" : "password"}
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            placeholder="At least 8 characters"
                                            required
                                            minLength={8}
                                            maxLength={128}
                                            autoComplete="new-password"
                                            className={inputClass}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword(!showPassword)}
                                            className="absolute right-1 top-1 flex size-7 items-center justify-center rounded text-ink-subtle hover:bg-canvas-muted hover:text-ink"
                                            tabIndex={-1}
                                        >
                                            <Icon name={showPassword ? "visibility_off" : "visibility"} className="size-4" />
                                            <span className="sr-only">
                                                {showPassword ? "Hide password" : "Show password"}
                                            </span>
                                        </button>
                                    </div>
                                    <p className="mt-1 text-label-sm text-ink-subtle">Minimum 8 characters.</p>
                                </div>

                                <div>
                                    <label htmlFor="confirm-password" className="mb-1 block text-label-md text-ink-soft">
                                        Confirm Password
                                    </label>
                                    <div className="relative">
                                        <Icon
                                            name="lock"
                                            className="pointer-events-none absolute left-3 top-2.5 size-4 text-ink-subtle"
                                        />
                                        <input
                                            id="confirm-password"
                                            type={showPassword ? "text" : "password"}
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            placeholder="Re-enter password"
                                            required
                                            minLength={8}
                                            maxLength={128}
                                            autoComplete="new-password"
                                            className={inputClass}
                                        />
                                    </div>
                                </div>

                                <button
                                    type="submit"
                                    disabled={submitting}
                                    className="flex h-9 w-full items-center justify-center gap-2 rounded bg-primary px-4 text-label-md text-on-primary hover:bg-primary-hover active:bg-primary-active disabled:cursor-not-allowed disabled:opacity-70"
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
