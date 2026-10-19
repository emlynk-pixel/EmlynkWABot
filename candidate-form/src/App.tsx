import { useCallback, useEffect, useState } from "react";
import { loadCandidateForm } from "./api/candidateDetails";
import { ApiError } from "./api/client";
import { ContactAdminScreen } from "./components/ContactAdmin";
import { LanguageSwitch } from "./components/LanguageSwitch";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { isApiConfigured } from "./config/env";
import type { MessageKey } from "./i18n/translations";
import { LanguageProvider } from "./i18n/LanguageContext";
import { useLanguage, type Message } from "./i18n/useLanguage";
import { CandidateFormPage } from "./pages/CandidateFormPage";
import { VerifyPage } from "./pages/VerifyPage";
import { getLinkSecret } from "./session/linkSecret";
import { clearSession, getSession } from "./session/tokenStore";
import { ThemeProvider } from "./theme/ThemeContext";
import type { FormLoadResponse } from "./types/api";

type View =
    | { name: "noLink" }
    | { name: "verify"; notice?: Message }
    | { name: "loading" }
    | { name: "loadFailed" }
    | { name: "form"; expiresAt: string; form: FormLoadResponse }
    | { name: "submitted"; justNow: boolean };

// Theme and language sit above every page: switching either only changes how
// the page looks or reads; the answers, the validation state and the session
// stay as they are.
export function App() {
    return (
        <ThemeProvider>
            <LanguageProvider>
                <CandidateForm />
            </LanguageProvider>
        </ThemeProvider>
    );
}

// A simple message screen (no link, loading, submitted).
function StatusScreen({ title, text, tone = "plain", children }: { title: MessageKey; text: MessageKey; tone?: "plain" | "success" | "error"; children?: React.ReactNode }) {
    const { t } = useLanguage();
    return (
        <section className={`panel status-panel status-${tone}`} role={tone === "error" ? "alert" : "status"}>
            {tone === "success" && <p className="status-icon" aria-hidden="true">✓</p>}
            <h1>{t(title)}</h1>
            <p className="lead">{t(text)}</p>
            {children}
        </section>
    );
}

function CandidateForm() {
    const { t } = useLanguage();
    // The link secret was read from the address (and removed from it) before
    // the first render (main.tsx). Without one there is nothing to verify.
    const [view, setView] = useState<View>(() => (getLinkSecret() ? { name: "verify" } : { name: "noLink" }));

    // Leaving the page ends the session (the token is only in memory anyway).
    useEffect(() => {
        const end = () => clearSession();
        window.addEventListener("pagehide", end);
        return () => window.removeEventListener("pagehide", end);
    }, []);

    // The session expired (or the token is gone): back to verification.
    const sessionEnded = useCallback(() => {
        clearSession();
        setView({ name: "verify", notice: { key: "session.ended" } });
    }, []);
    const alreadySubmitted = useCallback(() => {
        clearSession();
        setView({ name: "submitted", justNow: false });
    }, []);

    const load = useCallback(async (expiresAt: string) => {
        const session = getSession();
        if (!session) {
            sessionEnded();
            return;
        }
        setView({ name: "loading" });
        try {
            const form = await loadCandidateForm(session.token);
            setView({ name: "form", expiresAt, form });
        } catch (error) {
            if (error instanceof ApiError && error.status === 409) alreadySubmitted();
            else if (error instanceof ApiError && error.status === 401) sessionEnded();
            else setView({ name: "loadFailed" });
        }
    }, [sessionEnded, alreadySubmitted]);

    const linkSecret = getLinkSecret();

    let page: React.ReactNode;
    if (!isApiConfigured) {
        page = <StatusScreen title="notConfigured.title" text="notConfigured.lead" tone="error" />;
    } else if (view.name === "noLink" || !linkSecret) {
        page = <StatusScreen title="link.missingTitle" text="link.missingText" />;
    } else if (view.name === "verify") {
        page = <VerifyPage linkSecret={linkSecret} notice={view.notice} onVerified={(expiresAt) => void load(expiresAt)} onAlreadySubmitted={alreadySubmitted} />;
    } else if (view.name === "loading") {
        page = <StatusScreen title="form.loadingTitle" text="form.loadingText" />;
    } else if (view.name === "loadFailed") {
        page = (
            <StatusScreen title="form.loadFailedTitle" text="form.loadFailedText" tone="error">
                <button type="button" className="primary" onClick={() => void load(new Date(getSession()?.expiresAt ?? Date.now()).toISOString())}>{t("form.retry")}</button>
            </StatusScreen>
        );
    } else if (view.name === "submitted") {
        page = view.justNow
            ? <StatusScreen title="submitted.title" text="submitted.text" tone="success" />
            : <ContactAdminScreen />;
    } else {
        page = (
            <CandidateFormPage
                expiresAt={view.expiresAt}
                form={view.form}
                onSessionEnded={sessionEnded}
                onAlreadySubmitted={alreadySubmitted}
                onSubmitted={() => {
                    clearSession();
                    setView({ name: "submitted", justNow: true });
                }}
            />
        );
    }

    return (
        <div className="page">
            <header className="site-header">
                <div className="site-header-inner">
                    <p className="brand">
                        <span className="brand-mark" aria-hidden="true">E</span>
                        <span className="brand-text">
                            <span className="brand-name">Emlynk</span>
                            <span className="brand-sub">{t("app.subtitle")}</span>
                        </span>
                    </p>
                    <div className="header-controls">
                        <LanguageSwitch />
                        <ThemeSwitch />
                    </div>
                </div>
            </header>
            <main className="shell">{page}</main>
        </div>
    );
}
