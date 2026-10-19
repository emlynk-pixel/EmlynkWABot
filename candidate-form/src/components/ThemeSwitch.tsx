import { useLanguage } from "../i18n/useLanguage";
import { THEMES } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

// Light / Dark, small and beside the language switch. Two buttons with
// aria-pressed (keyboard: Tab, Enter, Space), labelled in the current language.
export function ThemeSwitch() {
    const { theme, setTheme } = useTheme();
    const { t } = useLanguage();
    return (
        <div className="segmented theme-switch" role="group" aria-label={t("theme.label")}>
            {THEMES.map((option) => (
                <button key={option} type="button" aria-pressed={theme === option} className={theme === option ? "active" : undefined} onClick={() => setTheme(option)}>
                    <span aria-hidden="true" className="theme-icon">{option === "light" ? "☀" : "☾"}</span>
                    <span className="theme-label">{t(option === "light" ? "theme.light" : "theme.dark")}</span>
                </button>
            ))}
        </div>
    );
}
