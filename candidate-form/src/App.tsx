import { useCallback, useEffect, useState } from "react";
import { LanguageSwitch } from "./components/LanguageSwitch";
import { isApiConfigured } from "./config/env";
import { LanguageProvider } from "./i18n/LanguageContext";
import { useLanguage, type Message } from "./i18n/useLanguage";
import { DetailsPage } from "./pages/DetailsPage";
import { VerifyPage } from "./pages/VerifyPage";
import { clearSession } from "./session/tokenStore";

type View = { name: "verify"; notice?: Message } | { name: "details"; expiresAt: string };

export function App() {
    return (
        <LanguageProvider>
            <CandidateForm />
        </LanguageProvider>
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

    const step = view.name === "verify" ? 1 : 2;

    return (
        <div className="page">
            <header className="site-header">
                <div className="site-header-inner">
                    <p className="brand">
                        <span className="brand-name">Emlynk</span>
                        <span className="brand-sub">{t("app.subtitle")}</span>
                    </p>
                    <LanguageSwitch />
                </div>
            </header>
            <main className="shell">
                {!isApiConfigured ? (
                    <section className="panel" role="alert">
                        <h1>{t("notConfigured.title")}</h1>
                        <p className="lead">{t("notConfigured.lead")}</p>
                    </section>
                ) : (
                    <>
                        <ol className="steps" aria-label={t("steps.label")}>
                            {(["steps.verify", "steps.details"] as const).map((label, index) => (
                                <li key={label} className={index + 1 === step ? "current" : index + 1 < step ? "done" : undefined} aria-current={index + 1 === step ? "step" : undefined}>
                                    <span className="step-number" aria-hidden="true">{index + 1 < step ? "✓" : index + 1}</span>
                                    {t(label)}
                                </li>
                            ))}
                        </ol>
                        {view.name === "verify" && <VerifyPage notice={view.notice} onVerified={(expiresAt) => setView({ name: "details", expiresAt })} />}
                        {view.name === "details" && (
                            <DetailsPage
                                expiresAt={view.expiresAt}
                                onSessionEnded={sessionEnded}
                                onFinish={() => {
                                    clearSession();
                                    setView({ name: "verify" });
                                }}
                            />
                        )}
                    </>
                )}
            </main>
        </div>
    );
}
