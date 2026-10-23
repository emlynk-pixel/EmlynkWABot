import { LANGUAGE_FULL_NAMES, LANGUAGE_NAMES, LANGUAGE_TITLES, LANGUAGES } from "../i18n/translations";
import { useLanguage } from "../i18n/useLanguage";

// Compact segmented control: EN | SI.
// Each button carries aria-label and title with the full language name so
// screen readers and mouse hover both see "English" / "Sinhala" while the
// visual label stays short. aria-pressed marks the active option; no check-mark
// needed – the filled pill background does that visually.
export function LanguageSwitch() {
    const { language, setLanguage } = useLanguage();
    return (
        <div className="segmented language-switch" role="group" aria-label="Language / භාෂාව">
            {LANGUAGES.map((option) => (
                <button
                    key={option}
                    type="button"
                    lang={option}
                    aria-pressed={language === option}
                    aria-label={LANGUAGE_FULL_NAMES[option]}
                    title={LANGUAGE_TITLES[option]}
                    className={language === option ? "active" : undefined}
                    onClick={() => setLanguage(option)}
                >
                    {LANGUAGE_NAMES[option]}
                </button>
            ))}
        </div>
    );
}
