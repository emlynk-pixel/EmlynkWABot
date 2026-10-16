import { LANGUAGE_NAMES, LANGUAGES } from "../i18n/translations";
import { useLanguage } from "../i18n/useLanguage";

// English / සිංහල, always visible in the header. Two real buttons (Tab,
// Enter, Space); the current one is marked with aria-pressed and a check,
// not colour alone. Each name is written in its own language and tagged
// with it, so a screen reader reads it correctly either way.
export function LanguageSwitch() {
    const { language, setLanguage } = useLanguage();
    return (
        <div className="language-switch" role="group" aria-label="Language / භාෂාව">
            {LANGUAGES.map((option) => (
                <button
                    key={option}
                    type="button"
                    lang={option}
                    aria-pressed={language === option}
                    className={language === option ? "active" : undefined}
                    onClick={() => setLanguage(option)}
                >
                    {language === option && <span aria-hidden="true">✓ </span>}
                    {LANGUAGE_NAMES[option]}
                </button>
            ))}
        </div>
    );
}
