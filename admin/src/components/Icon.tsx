// Material Symbols (outlined, weight 400), the icon set used in the Stitch
// design. Imported one SVG at a time so the bundle only carries the icons in
// use, instead of a 1-1.5 MB icon font. The markup is a build-time constant
// from the package, never user data.
import assignmentLate from "@material-symbols/svg-400/outlined/assignment_late.svg?raw";
import checkCircle from "@material-symbols/svg-400/outlined/check_circle.svg?raw";
import darkMode from "@material-symbols/svg-400/outlined/dark_mode.svg?raw";
import edit from "@material-symbols/svg-400/outlined/edit.svg?raw";
import event from "@material-symbols/svg-400/outlined/event.svg?raw";
import lightMode from "@material-symbols/svg-400/outlined/light_mode.svg?raw";
import personSearch from "@material-symbols/svg-400/outlined/person_search.svg?raw";
import search from "@material-symbols/svg-400/outlined/search.svg?raw";
import summarize from "@material-symbols/svg-400/outlined/summarize.svg?raw";
import sync from "@material-symbols/svg-400/outlined/sync.svg?raw";
import chevronLeft from "@material-symbols/svg-400/outlined/chevron_left.svg?raw";
import dashboard from "@material-symbols/svg-400/outlined/dashboard.svg?raw";
import description from "@material-symbols/svg-400/outlined/description.svg?raw";
import error from "@material-symbols/svg-400/outlined/error.svg?raw";
import factCheck from "@material-symbols/svg-400/outlined/fact_check.svg?raw";
import group from "@material-symbols/svg-400/outlined/group.svg?raw";
import localPolice from "@material-symbols/svg-400/outlined/local_police.svg?raw";
import lock from "@material-symbols/svg-400/outlined/lock.svg?raw";
import logout from "@material-symbols/svg-400/outlined/logout.svg?raw";
import mail from "@material-symbols/svg-400/outlined/mail.svg?raw";
import menu from "@material-symbols/svg-400/outlined/menu.svg?raw";
import progressActivity from "@material-symbols/svg-400/outlined/progress_activity.svg?raw";
import visibility from "@material-symbols/svg-400/outlined/visibility.svg?raw";
import visibilityOff from "@material-symbols/svg-400/outlined/visibility_off.svg?raw";

const ICONS = {
    assignment_late: assignmentLate,
    check_circle: checkCircle,
    dark_mode: darkMode,
    edit,
    event,
    light_mode: lightMode,
    person_search: personSearch,
    search,
    summarize,
    sync,
    chevron_left: chevronLeft,
    dashboard,
    description,
    error,
    fact_check: factCheck,
    group,
    local_police: localPolice,
    lock,
    logout,
    mail,
    menu,
    progress_activity: progressActivity,
    visibility,
    visibility_off: visibilityOff,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "size-5" }: { name: IconName; className?: string }) {
    return (
        <span
            aria-hidden="true"
            className={`icon inline-block shrink-0 ${className}`}
            dangerouslySetInnerHTML={{ __html: ICONS[name] }}
        />
    );
}
