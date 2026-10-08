import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Icon } from "../components/Icon";
import { completeInvitation } from "../api/auth";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { authLinkError, getAuthClient } from "../auth/supabaseClient";
import { FormField } from "../components/Form";
import { NewPasswordFields, hasNewPasswordErrors, validateNewPassword, type NewPasswordErrors } from "../components/NewPasswordFields";
import { inputClass } from "../components/ui";

const INVALID_LINK = "This invitation link is invalid or has expired. Ask an administrator to send a new invitation.";

// Invited user setup. The Supabase invite link signs the invitee in (the
// session arrives in the URL); here they choose a password (Supabase Auth
// stores it), then the backend activates their account. The role was set by
// the administrator who invited them and is shown, never chosen, here.
export function SetupPasswordPage() {
    const navigate = useNavigate();
    const { refreshUser } = useAuth();
    const [linkError] = useState(() => authLinkError());
    const [loading, setLoading] = useState(true);
    const [email, setEmail] = useState<string | null>(null);
    const [validationError, setValidationError] = useState<string | null>(null);

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
            .then(({ data }) => {
                if (cancelled) return;
                if (data.session?.user.email) setEmail(data.session.user.email);
                else setValidationError(INVALID_LINK);
            })
            .catch(() => { if (!cancelled) setValidationError(INVALID_LINK); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => {
            cancelled = true;
        };
    }, [linkError]);

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();
        setSubmitError(null);
        const errors = validateNewPassword(password, confirmPassword);
        setFieldErrors(errors);
        if (hasNewPasswordErrors(errors)) {
            document.getElementById(errors.password ? "setup-password" : "confirm-password")?.focus();
            return;
        }

        setSubmitting(true);
        try {
            const auth = getAuthClient();
            const { error } = await auth.updateUser({ password });
            if (error) {
                setSubmitError(error.code === "weak_password" ? "Choose a stronger password." : "Your password could not be set. Please try again.");
                return;
            }
            const { data } = await auth.getSession();
            if (!data.session) {
                setSubmitError(INVALID_LINK);
                return;
            }
            await completeInvitation(data.session.access_token);
            await refreshUser();
            setSuccess(true);
        } catch (err) {
            setSubmitError(err instanceof ApiError && err.status === 403
                ? "This invitation is no longer valid. Ask an administrator to invite you again."
                : err instanceof ApiError ? err.message : "Your account could not be activated. Please try again.");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-12">
            <div className="w-full max-w-md">
                <div className="mb-6 flex items-center justify-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded bg-primary text-headline-sm font-semibold text-on-primary">E</span>
                    <div>
                        <p className="text-headline-sm font-bold text-ink">EmlynkWABot</p>
                        <p className="text-label-caps uppercase text-ink-subtle">Admin Console</p>
                    </div>
                </div>

                <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
                    {loading ? (
                        <div className="py-8 text-center text-ink-muted" role="status">
                            <Icon name="progress_activity" className="mx-auto mb-3 size-7 animate-spin text-primary" />
                            <p className="text-body-sm">Verifying invitation link…</p>
                        </div>
                    ) : validationError ? (
                        <div className="py-4 text-center">
                            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-critical-bg text-critical">
                                <Icon name="error" className="size-6" />
                            </div>
                            <h2 className="text-headline-sm font-semibold text-ink">Invitation Problem</h2>
                            <p className="mt-2 text-body-sm text-ink-muted">{validationError}</p>
                            <button type="button" onClick={() => navigate("/login")} className="mt-6 w-full rounded bg-primary py-2 text-label-md font-medium text-on-primary hover:bg-primary-hover">
                                Return to Sign In
                            </button>
                        </div>
                    ) : success ? (
                        <div className="py-4 text-center">
                            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-verified-bg text-verified">
                                <Icon name="check_circle" className="size-7" />
                            </div>
                            <h2 className="text-headline-sm font-semibold text-ink">Account Activated!</h2>
                            <p className="mt-2 text-body-sm text-ink-muted">Your password is set and your account is active.</p>
                            <button type="button" onClick={() => navigate("/", { replace: true })} className="mt-6 w-full rounded bg-primary py-2 text-label-md font-medium text-on-primary hover:bg-primary-hover">
                                Continue to the console
                            </button>
                        </div>
                    ) : (
                        <div>
                            <div className="mb-5 text-center">
                                <h1 className="text-headline-md font-bold text-ink">Set Your Password</h1>
                                <p className="mt-1 text-body-sm text-ink-muted">Choose a password to finish setting up your account.</p>
                            </div>

                            {submitError && (
                                <div role="alert" className="mb-4 flex items-start gap-2 rounded border border-critical-border bg-critical-bg p-3 text-body-sm text-critical">
                                    <Icon name="error" className="mt-0.5 size-4 shrink-0" />
                                    <span>{submitError}</span>
                                </div>
                            )}

                            <form onSubmit={handleSubmit} className="space-y-5" noValidate>
                                <FormField id="setup-email" label="Email Address" help="The address this invitation was sent to. It is your sign-in email.">
                                    <input id="setup-email" type="text" value={email ?? ""} disabled className={inputClass()} />
                                </FormField>

                                <NewPasswordFields
                                    passwordId="setup-password"
                                    password={password}
                                    confirm={confirmPassword}
                                    errors={fieldErrors}
                                    confirmPlaceholder="Re-enter your password"
                                    onChange={(next) => {
                                        setPassword(next.password);
                                        setConfirmPassword(next.confirm);
                                        setFieldErrors(next.errors);
                                    }}
                                />

                                <button
                                    type="submit"
                                    disabled={submitting}
                                    className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-label-md font-medium text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    <Icon name={submitting ? "progress_activity" : "check_circle"} className={`size-4 ${submitting ? "animate-spin" : ""}`} />
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
