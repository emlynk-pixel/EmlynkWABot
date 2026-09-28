import { useState, useEffect, type FormEvent } from "react";
import { useSearchParams, useNavigate } from "react-router";
import { Icon } from "../components/Icon";
import { validateInvitation, setupPassword, type InvitationDetails } from "../api/auth";
import { ApiError } from "../api/client";

export function SetupPasswordPage() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const token = searchParams.get("token");

    const [loading, setLoading] = useState(true);
    const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
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
            setValidationError("No invitation token provided. Please check the link in your invitation email.");
            setLoading(false);
            return;
        }

        let cancelled = false;
        async function checkToken() {
            try {
                const details = await validateInvitation(token!);
                if (!cancelled) {
                    setInvitation(details);
                    setLoading(false);
                }
            } catch (err) {
                if (!cancelled) {
                    setValidationError(
                        err instanceof ApiError
                            ? err.message
                            : "Invalid or expired invitation link. Please request a new invitation."
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
            await setupPassword(token!, password);
            setSuccess(true);
        } catch (err) {
            setSubmitError(err instanceof ApiError ? err.message : "Failed to set password. Please try again.");
        } finally {
            setSubmitting(false);
        }
    }

    const inputClass =
        "h-9 w-full rounded border border-border-strong bg-surface pl-9 pr-3 text-body-sm text-ink shadow-[inset_0_1px_1px_rgba(15,23,42,0.03)] placeholder:text-ink-subtle focus:border-primary focus:outline-none";

    return (
        <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-12">
            <div className="w-full max-w-md">
                {/* Brand / Logo */}
                <div className="mb-6 flex items-center justify-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded bg-primary font-semibold text-on-primary text-headline-sm">
                        E
                    </span>
                    <div>
                        <p className="text-headline-sm font-bold text-ink">EmlynkWABot</p>
                        <p className="text-label-caps uppercase text-ink-subtle">Admin Console</p>
                    </div>
                </div>

                <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
                    {loading ? (
                        <div className="py-8 text-center text-ink-muted">
                            <Icon name="progress_activity" className="mx-auto size-7 animate-spin text-primary mb-3" />
                            <p className="text-body-sm">Verifying invitation link…</p>
                        </div>
                    ) : validationError ? (
                        <div className="text-center py-4">
                            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-critical-bg text-critical">
                                <Icon name="error" className="size-6" />
                            </div>
                            <h2 className="text-headline-sm font-semibold text-ink">Invitation Problem</h2>
                            <p className="mt-2 text-body-sm text-ink-muted">{validationError}</p>
                            <div className="mt-6">
                                <button
                                    type="button"
                                    onClick={() => navigate("/login")}
                                    className="w-full rounded bg-primary py-2 text-label-md font-medium text-on-primary hover:bg-primary-hover"
                                >
                                    Return to Sign In
                                </button>
                            </div>
                        </div>
                    ) : success ? (
                        <div className="text-center py-4">
                            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-verified-bg text-verified">
                                <Icon name="check_circle" className="size-7" />
                            </div>
                            <h2 className="text-headline-sm font-semibold text-ink">Account Activated!</h2>
                            <p className="mt-2 text-body-sm text-ink-muted">
                                Your password has been successfully configured. Your account is now active and ready to use.
                            </p>
                            <div className="mt-6">
                                <button
                                    type="button"
                                    onClick={() => navigate("/login")}
                                    className="w-full rounded bg-primary py-2 text-label-md font-medium text-on-primary hover:bg-primary-hover"
                                >
                                    Continue to Sign In
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div>
                            <div className="mb-5 text-center">
                                <h1 className="text-headline-md font-bold text-ink">Set Your Password</h1>
                                <p className="mt-1 text-body-sm text-ink-muted">
                                    Welcome, <strong className="text-ink">{invitation?.name}</strong>. Create your password to activate your{" "}
                                    <span className="font-semibold text-primary">{invitation?.role}</span> account.
                                </p>
                            </div>

                            {submitError && (
                                <div className="mb-4 flex items-start gap-2 rounded border border-critical-border bg-critical-bg p-3 text-body-sm text-critical">
                                    <Icon name="error" className="size-4 shrink-0 mt-0.5" />
                                    <span>{submitError}</span>
                                </div>
                            )}

                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div>
                                    <label htmlFor="setup-email" className="block text-label-md text-ink font-medium mb-1">
                                        Email Address
                                    </label>
                                    <input
                                        id="setup-email"
                                        type="text"
                                        value={invitation?.email ?? ""}
                                        disabled
                                        className="h-9 w-full rounded border border-border bg-canvas-muted px-3 text-body-sm text-ink-muted cursor-not-allowed"
                                    />
                                </div>

                                <div>
                                    <label htmlFor="setup-password" className="block text-label-md text-ink font-medium mb-1">
                                        New Password
                                    </label>
                                    <div className="relative">
                                        <Icon name="lock" className="pointer-events-none absolute left-3 top-2.5 size-4 text-ink-subtle" />
                                        <input
                                            id="setup-password"
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
                                            className="absolute right-2.5 top-2 text-ink-subtle hover:text-ink"
                                            tabIndex={-1}
                                        >
                                            <Icon name={showPassword ? "visibility_off" : "visibility"} className="size-4" />
                                            <span className="sr-only">{showPassword ? "Hide password" : "Show password"}</span>
                                        </button>
                                    </div>
                                    <p className="mt-1 text-label-sm text-ink-subtle">Minimum 8 characters.</p>
                                </div>

                                <div>
                                    <label htmlFor="confirm-password" className="block text-label-md text-ink font-medium mb-1">
                                        Confirm Password
                                    </label>
                                    <div className="relative">
                                        <Icon name="lock" className="pointer-events-none absolute left-3 top-2.5 size-4 text-ink-subtle" />
                                        <input
                                            id="confirm-password"
                                            type={showPassword ? "text" : "password"}
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            placeholder="Re-enter your password"
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
                                    className="w-full flex h-9 items-center justify-center gap-2 rounded bg-primary text-label-md font-medium text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60 shadow-sm"
                                >
                                    <Icon
                                        name={submitting ? "progress_activity" : "check_circle"}
                                        className={`size-4 ${submitting ? "animate-spin" : ""}`}
                                    />
                                    <span>{submitting ? "Activating Account…" : "Activate Account"}</span>
                                </button>
                            </form>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
