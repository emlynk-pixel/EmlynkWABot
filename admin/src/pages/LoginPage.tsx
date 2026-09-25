import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate, type Location } from "react-router";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { Icon } from "../components/Icon";

// Only returns within the admin app are followed after sign-in.
function returnPath(state: unknown): string {
    const from = (state as { from?: Location } | null)?.from;
    const path = from?.pathname;
    return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && path !== "/login"
        ? `${path}${from?.search ?? ""}`
        : "/";
}

// Same limits the backend enforces (src/routes/auth.js).
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 128;

export function LoginPage() {
    const { status, signIn } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (status === "authenticated") {
        return <Navigate to={returnPath(location.state)} replace />;
    }

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (submitting) return;
        setError(null);

        if (!email.trim() || !password) {
            setError("Enter your email and password.");
            return;
        }

        setSubmitting(true);
        try {
            await signIn(email.trim(), password);
            navigate(returnPath(location.state), { replace: true });
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "Something went wrong. Please try again.");
            setPassword("");
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
                    <span className="flex size-10 items-center justify-center rounded-lg bg-sidebar text-headline-sm text-sidebar-text-active">E</span>
                    <div>
                        <p className="text-headline-sm text-ink">EmlynkWABot</p>
                        <p className="text-label-caps uppercase text-ink-subtle">Admin Console</p>
                    </div>
                </div>

                <div className="rounded-lg border border-border bg-surface p-6 shadow-surface">
                    <h1 className="text-headline-lg text-ink">Sign in</h1>
                    <p className="mt-1 text-body-sm text-ink-muted">Use your administrator account.</p>

                    {error && (
                        <div role="alert" className="mt-4 flex items-start gap-2 rounded border border-critical-border bg-critical-bg px-3 py-2 text-body-sm text-critical">
                            <Icon name="error" className="mt-px size-4" />
                            <span>{error}</span>
                        </div>
                    )}

                    <form className="mt-5 space-y-4" onSubmit={handleSubmit} noValidate>
                        <div>
                            <label htmlFor="email" className="mb-1 block text-label-md text-ink-soft">Email</label>
                            <div className="relative">
                                <Icon name="mail" className="pointer-events-none absolute left-3 top-2.5 size-4 text-ink-subtle" />
                                <input
                                    id="email"
                                    name="email"
                                    type="email"
                                    autoComplete="username"
                                    maxLength={MAX_EMAIL_LENGTH}
                                    required
                                    value={email}
                                    onChange={(event) => setEmail(event.target.value)}
                                    className={inputClass}
                                />
                            </div>
                        </div>

                        <div>
                            <label htmlFor="password" className="mb-1 block text-label-md text-ink-soft">Password</label>
                            <div className="relative">
                                <Icon name="lock" className="pointer-events-none absolute left-3 top-2.5 size-4 text-ink-subtle" />
                                <input
                                    id="password"
                                    name="password"
                                    type={showPassword ? "text" : "password"}
                                    autoComplete="current-password"
                                    maxLength={MAX_PASSWORD_LENGTH}
                                    required
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                    className={`${inputClass} pr-10`}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword((value) => !value)}
                                    className="absolute right-1 top-1 flex size-7 items-center justify-center rounded text-ink-subtle hover:bg-canvas-muted hover:text-ink"
                                >
                                    <Icon name={showPassword ? "visibility_off" : "visibility"} className="size-4" />
                                    <span className="sr-only">{showPassword ? "Hide password" : "Show password"}</span>
                                </button>
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={submitting}
                            className="flex h-9 w-full items-center justify-center gap-2 rounded bg-primary px-4 text-label-md text-on-primary hover:bg-primary-hover active:bg-primary-active disabled:cursor-not-allowed disabled:opacity-70"
                        >
                            {submitting && <Icon name="progress_activity" className="size-4 animate-spin" />}
                            {submitting ? "Signing in…" : "Sign in"}
                        </button>
                    </form>
                </div>

                <p className="mt-4 text-center text-label-sm text-ink-subtle">
                    Accounts are created by an operator with <code className="font-medium">npm run admin:create</code>.
                </p>
            </div>
        </div>
    );
}
