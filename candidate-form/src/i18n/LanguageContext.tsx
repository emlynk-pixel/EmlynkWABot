import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { translate, type Language, type MessageKey, type MessageParams } from "./translations";

export type LanguageContextValue = {
    language: Language;
    setLanguage: (language: Language) => void;
    t: (key: MessageKey, params?: MessageParams) => string;
};

export const LanguageContext = createContext<LanguageContextValue | null>(null);

// The chosen language lives in React state only. Switching it re-renders the
// text and nothing else: form values and validation results are kept by the
// pages as values and message keys, never as translated strings, so they
// survive a switch unchanged and show in the new language. Nothing is stored
// in the browser (a reload starts in English).
export function LanguageProvider({ children, initialLanguage = "en" }: { children: ReactNode; initialLanguage?: Language }) {
    const [language, setLanguage] = useState<Language>(initialLanguage);

    // Screen readers and the browser's fonts follow the page language.
    useEffect(() => {
        document.documentElement.lang = language;
    }, [language]);

    const t = useCallback((key: MessageKey, params?: MessageParams) => translate(language, key, params), [language]);
    const value = useMemo(() => ({ language, setLanguage, t }), [language, t]);
    return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
