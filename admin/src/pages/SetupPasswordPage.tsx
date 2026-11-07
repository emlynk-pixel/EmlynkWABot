import { AuthShell } from "../components/AuthShell";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Icon } from "../components/Icon";
import { completeInvitation, fetchInvitationStatus } from "../api/auth";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { authLinkError, getAuthClient } from "../auth/supabaseClient";
import { FormField } from "../components/Form";
import { NewPasswordFields, hasNewPasswordErrors, validateNewPassword, type NewPasswordErrors } from "../components/NewPasswordFields";
import { inputClass } from "../components/ui";

const INVALID_LINK = "This invitation link is invalid or has expired. Ask an administrator to send a new invitation.";
const REVOKED = "This invitation is no longer valid. Ask an administrator to invite you again.";

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
    // The password is saved at Supabase; only the account activation is left (retry it alone).
    const [passwordSaved, setPasswordSaved] = useState(false);

    useEffect(() => {
        if (linkError) {
            setValidationError(INVALID_LINK);
            setLoading(false);
            return;
        }
        let cancelled = false;
        (async () => {
            const { data } = await getAuthClient().getSession();
            if (!data.session?.user.email) return setValidationError(INVALID_LINK);
            // Ask the application BEFORE any password is set: a revoked invitation (the link still
            // signs in at Supabase until it expires) must not end with a password and no account.
            const status = await fetchInvitationStatus(data.session.access_token);
            if (cancelled) return;
            if (status !== "INVITED" && status !== "ACTIVE") return setValidationError(REVOKED);
            setEmail(data.session.user.email);
        })()
            .catch(() => { if (!cancelled) setValidationError(INVALID_LINK); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => {
            cancelled = true;
        };
    }, [linkError]);

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();
        setSubmitError(null);
        // Once the password is saved, a retry only activates the account (never asks for it again).
        if (!passwordSaved) {
            const errors = validateNewPassword(password, confirmPassword);
            setFieldErrors(errors);
            if (hasNewPasswordErrors(errors)) {
                document.getElementById(errors.password ? "setup-password" : "confirm-password")?.focus();
                return;
            }
        }

        setSubmitting(true);
        try {
            const auth = getAuthClient();
            if (!passwordSaved) {
                const { error } = await auth.updateUser({ password });
                if (error) {
                    setSubmitError(error.code === "weak_password" ? "Choose a stronger password." : "Your password could not be set. Please try again.");
                    return;
                }
                setPasswordSaved(true);
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
                ? REVOKED
                : "Your password is saved, but your account could not be activated yet. Please try again (you can also just sign in with your new password).");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <AuthShell>

                <div className="rounded-xl border border-border bg-surface p-6 shadow-sm">
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
                            <button type="button" onClick={() => navigate("/login")} className="mt-6 w-full rounded-lg bg-primary py-2 text-label-md font-medium text-on-primary hover:bg-primary-hover">
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
                            <button type="button" onClick={() => navigate("/", { replace: true })} className="mt-6 w-full rounded-lg bg-primary py-2 text-label-md font-medium text-on-primary hover:bg-primary-hover">
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
                                <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-critical-border bg-critical-bg p-3 text-body-sm text-critical">
                                    <Icon name="error" className="mt-0.5 size-4 shrink-0" />
                                    <span>{submitError}</span>
                                </div>
                            )}

                            <form onSubmit={handleSubmit} className="space-y-5" noValidate>
                                <FormField id="setup-email" label="Email Address" help="The address this invitation was sent to. It is your sign-in email.">
                                    <input id="setup-email" type="text" value={email ?? ""} disabled className={inputClass()} />
                                </FormField>

                                {!passwordSaved && (
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
                                )}

                                <button
                                    type="submit"
                                    disabled={submitting}
                                    className="flex h-8 w-full items-center justify-center gap-2 rounded-lg bg-primary text-label-md font-medium text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    <Icon name={submitting ? "progress_activity" : "check_circle"} className={`size-4 ${submitting ? "animate-spin" : ""}`} />
                                    <span>{submitting ? "Activating Account…" : passwordSaved ? "Retry activation" : "Activate Account"}</span>
                                </button>
                            </form>
                        </div>
                    )}
                </div>
        </AuthShell>
    );
}
