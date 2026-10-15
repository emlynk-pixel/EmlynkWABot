import { useEffect, useState } from "react";
import { isApiConfigured } from "./config/env";
import { VerifiedPage } from "./pages/VerifiedPage";
import { VerifyPage } from "./pages/VerifyPage";
import { clearSession } from "./session/tokenStore";

type View = { name: "verify" } | { name: "verified"; expiresAt: string };

export function App() {
    const [view, setView] = useState<View>({ name: "verify" });

    // Leaving the page ends the session (the token is only in memory anyway).
    useEffect(() => {
        const end = () => clearSession();
        window.addEventListener("pagehide", end);
        return () => window.removeEventListener("pagehide", end);
    }, []);

    if (!isApiConfigured) {
        return (
            <main className="shell">
                <section className="card" role="alert">
                    <h1>Not available</h1>
                    <p className="lead">This form is not configured yet. Please try again later.</p>
                </section>
            </main>
        );
    }

    return (
        <main className="shell">
            {view.name === "verify" && <VerifyPage onVerified={(expiresAt) => setView({ name: "verified", expiresAt })} />}
            {view.name === "verified" && (
                <VerifiedPage
                    expiresAt={view.expiresAt}
                    onDone={() => {
                        clearSession();
                        setView({ name: "verify" });
                    }}
                />
            )}
        </main>
    );
}
