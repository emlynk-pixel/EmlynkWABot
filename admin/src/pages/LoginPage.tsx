import { useState, useEffect, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate, type Location } from "react-router";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { Icon } from "../components/Icon";
import { FormField, fieldA11y } from "../components/Form";
import { inputClass } from "../components/ui";
import { emailError } from "../components/validation";

type LoginErrors = { email?: string | null; password?: string | null };

function validateLogin(email: string, password: string): LoginErrors {
    return { email: emailError(email), password: password ? null : "Enter your password." };
}

// Only returns within the admin app are followed after sign-in.
function returnPath(state: unknown): string {
    const from = (state as { from?: Location } | null)?.from;
    const path = from?.pathname;
    return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && path !== "/login"
        ? `${path}${from?.search ?? ""}`
        : "/";
}

// Input caps (an email address is at most 254 characters).
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 128;

export function LoginPage() {
    const { status, signIn, notice } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<LoginErrors>({});
    const [resetTime, setResetTime] = useState<Date | null>(null);
    const [countdown, setCountdown] = useState<number | null>(null);

    useEffect(() => {
        if (!resetTime) {
            setCountdown(null);
            return;
        }
        const update = () => {
            const left = Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
            setCountdown(left);
            if (left <= 0) {
                setResetTime(null);
                setError(null);
            }
        };
        update();
        const id = setInterval(update, 1000);
        return () => clearInterval(id);
    }, [resetTime]);

    if (status === "authenticated") {
        return <Navigate to={returnPath(location.state)} replace />;
    }

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (submitting) return;
        setError(null);

        const errors = validateLogin(email, password);
        setFieldErrors(errors);
        if (errors.email || errors.password) {
            document.getElementById(errors.email ? "email" : "password")?.focus();
            return;
        }

        setSubmitting(true);
        try {
            await signIn(email.trim(), password);
            navigate(returnPath(location.state), { replace: true });
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "Something went wrong. Please try again.");
            if (caught instanceof ApiError && caught.resetTime) {
                setResetTime(caught.resetTime);
            } else {
                setResetTime(null);
            }
            setPassword("");
        } finally {
            setSubmitting(false);
        }
    }

    // An error shown for a field is cleared as soon as its value is valid.
    const recheck = (field: keyof LoginErrors, nextEmail: string, nextPassword: string) => {
        if (fieldErrors[field]) setFieldErrors((current) => ({ ...current, [field]: validateLogin(nextEmail, nextPassword)[field] }));
    };

    return (
        <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-12">
            <div className="w-full max-w-sm">
                <div className="mb-6 flex items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-lg bg-sidebar text-headline-sm text-sidebar-text-active">E</span>
                    <div>
                        <p className="text-headline-sm text-ink">EmlynkWABot</p>
                        <p className="text-label-caps uppercase text-ink-subtle">Admin Console</p>
                    </div>
                </div>

                <div className="rounded-lg border border-border bg-surface p-6 shadow-surface">
                    <h1 className="text-headline-lg text-ink">Sign in</h1>
                    <p className="mt-1 text-body-sm text-ink-muted">Use your console account.</p>

                    {!error && notice && (
                        <div role="alert" className="mt-4 flex items-start gap-2 rounded border border-review-border bg-review-bg px-3 py-2 text-body-sm text-review">
                            <Icon name="error" className="mt-px size-4 shrink-0" />
                            <span>{notice}</span>
                        </div>
                    )}

                    {error && (
                        <div role="alert" className="mt-4 flex flex-col gap-1 rounded border border-critical-border bg-critical-bg px-3 py-2 text-body-sm text-critical">
                            <div className="flex items-start gap-2">
                                <Icon name="error" className="mt-px size-4 shrink-0" />
                                <span>{error}</span>
                            </div>
                            {countdown !== null && countdown > 0 && (
                                <p className="pl-6 font-medium">
                                    Please try again in {Math.floor(countdown / 60)}m {String(countdown % 60).padStart(2, '0')}s
                                </p>
                            )}
                        </div>
                    )}

                    <form className="mt-6 space-y-5" onSubmit={handleSubmit} noValidate>
                        <FormField id="email" label="Email" required error={fieldErrors.email}>
                            <div className="relative">
                                <Icon name="mail" className="pointer-events-none absolute left-3 top-3 size-4 text-ink-subtle" />
                                <input
                                    {...fieldA11y("email", fieldErrors.email)}
                                    name="email"
                                    type="email"
                                    autoComplete="username"
                                    maxLength={MAX_EMAIL_LENGTH}
                                    required
                                    value={email}
                                    onChange={(event) => {
                                        setEmail(event.target.value);
                                        recheck("email", event.target.value, password);
                                    }}
                                    className={inputClass(Boolean(fieldErrors.email), { padding: "pl-9 pr-3" })}
                                />
                            </div>
                        </FormField>

                        <FormField
                            id="password"
                            label="Password"
                            required
                            error={fieldErrors.password}
                            action={
                                <Link to="/forgot-password" className="text-label-sm font-medium text-primary hover:text-primary-hover hover:underline">
                                    Forgot password?
                                </Link>
                            }
                        >
                            <div className="relative">
                                <Icon name="lock" className="pointer-events-none absolute left-3 top-3 size-4 text-ink-subtle" />
                                <input
                                    {...fieldA11y("password", fieldErrors.password)}
                                    name="password"
                                    type={showPassword ? "text" : "password"}
                                    autoComplete="current-password"
                                    maxLength={MAX_PASSWORD_LENGTH}
                                    required
                                    value={password}
                                    onChange={(event) => {
                                        setPassword(event.target.value);
                                        recheck("password", email, event.target.value);
                                    }}
                                    className={inputClass(Boolean(fieldErrors.password), { padding: "pl-9 pr-10" })}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword((value) => !value)}
                                    className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded text-ink-subtle hover:bg-canvas-muted hover:text-ink"
                                >
                                    <Icon name={showPassword ? "visibility_off" : "visibility"} className="size-4" />
                                    <span className="sr-only">{showPassword ? "Hide password" : "Show password"}</span>
                                </button>
                            </div>
                        </FormField>

                        <button
                            type="submit"
                            disabled={submitting}
                            className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-label-md text-on-primary hover:bg-primary-hover active:bg-primary-active disabled:cursor-not-allowed disabled:opacity-70"
                        >
                            {submitting && <Icon name="progress_activity" className="size-4 animate-spin" />}
                            {submitting ? "Signing in…" : "Sign in"}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}
