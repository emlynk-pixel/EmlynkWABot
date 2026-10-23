import { useLanguage } from "../i18n/useLanguage";
import { THEMES } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

// Light / Dark, small and beside the language switch: two icon buttons (sun,
// moon) with aria-pressed (keyboard: Tab, Enter, Space). No visible text; each
// button is named by aria-label ("Use light theme") and title ("Light theme"),
// in the current language. Inline SVG: no icon library, same look everywhere.
function SunIcon() {
    return (
        <svg className="theme-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
        </svg>
    );
}
function MoonIcon() {
    return (
        <svg className="theme-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" />
        </svg>
    );
}

export function ThemeSwitch() {
    const { theme, setTheme } = useTheme();
    const { t } = useLanguage();
    return (
        <div className="segmented theme-switch" role="group" aria-label={t("theme.label")}>
            {THEMES.map((option) => (
                <button
                    key={option}
                    type="button"
                    aria-pressed={theme === option}
                    aria-label={t(option === "light" ? "theme.useLight" : "theme.useDark")}
                    title={t(option === "light" ? "theme.lightTitle" : "theme.darkTitle")}
                    className={theme === option ? "active" : undefined}
                    onClick={() => setTheme(option)}
                >
                    {option === "light" ? <SunIcon /> : <MoonIcon />}
                </button>
            ))}
        </div>
    );
}
