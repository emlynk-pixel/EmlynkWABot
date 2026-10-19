import { useContext } from "react";
import { LanguageContext, type LanguageContextValue } from "./LanguageContext";
import type { MessageKey, MessageParams } from "./translations";

export function useLanguage(): LanguageContextValue {
    const value = useContext(LanguageContext);
    if (!value) throw new Error("useLanguage must be used inside <LanguageProvider>");
    return value;
}

// A message to show later, kept as a key (and its values) rather than as
// text, so it is shown in whatever language is current when it renders.
export type Message = { key: MessageKey; params?: MessageParams };
