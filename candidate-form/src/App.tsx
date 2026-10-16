import { useCallback, useEffect, useState } from "react";
import { LanguageSwitch } from "./components/LanguageSwitch";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { isApiConfigured } from "./config/env";
import { LanguageProvider } from "./i18n/LanguageContext";
import { useLanguage, type Message } from "./i18n/useLanguage";
import { CandidateFormPage } from "./pages/CandidateFormPage";
import { VerifyPage } from "./pages/VerifyPage";
import { clearSession, getSession, type VerifiedIdentity } from "./session/tokenStore";
import { ThemeProvider } from "./theme/ThemeContext";

type View = { name: "verify"; notice?: Message } | { name: "form"; expiresAt: string; identity: VerifiedIdentity };

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

function CandidateForm() {
    const { t } = useLanguage();
    const [view, setView] = useState<View>({ name: "verify" });

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

    const verified = (expiresAt: string) => {
        const session = getSession();
        if (session) setView({ name: "form", expiresAt, identity: session.identity });
    };

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
            <main className="shell">
                {!isApiConfigured ? (
                    <section className="panel" role="alert">
                        <h1>{t("notConfigured.title")}</h1>
                        <p className="lead">{t("notConfigured.lead")}</p>
                    </section>
                ) : view.name === "verify" ? (
                    <VerifyPage notice={view.notice} onVerified={verified} />
                ) : (
                    <CandidateFormPage
                        expiresAt={view.expiresAt}
                        identity={view.identity}
                        onSessionEnded={sessionEnded}
                        onFinish={() => {
                            clearSession();
                            setView({ name: "verify" });
                        }}
                    />
                )}
            </main>
        </div>
    );
}
