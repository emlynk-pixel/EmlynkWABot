import { useEffect, useMemo, useState, type ReactNode } from "react";
import { loadBranding } from "../api/candidateDetails";
import { isApiConfigured } from "../config/env";
import { useTheme } from "../theme/useTheme";
import { applyBranding, BrandingContext, DEFAULT_BRANDING, parseBranding, type Branding } from "./branding";

// A slow network never holds the form back: after this, it shows the defaults.
export const BRANDING_TIMEOUT_MS = 2500;

// Loads the form's branding once. Any failure leaves the EMLYNK defaults, so
// the form always works. `ready` lets the header wait, so a saved title or logo
// doesn't appear after the default one.
export function BrandingProvider({ children }: { children: ReactNode }) {
    const { theme } = useTheme();
    const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
    const [ready, setReady] = useState(!isApiConfigured);

    useEffect(() => {
        if (!isApiConfigured) return undefined;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), BRANDING_TIMEOUT_MS);
        loadBranding(controller.signal)
            .then((value) => setBranding(parseBranding(value)))
            .catch(() => undefined)
            .finally(() => {
                window.clearTimeout(timeout);
                setReady(true);
            });
        return () => {
            window.clearTimeout(timeout);
            controller.abort();
        };
    }, []);

    useEffect(() => applyBranding(branding, theme), [branding, theme]);
    useEffect(() => {
        document.title = branding.formTitle;
    }, [branding.formTitle]);

    const value = useMemo(() => ({ branding, ready }), [branding, ready]);
    return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}
