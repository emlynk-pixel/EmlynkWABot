// Calendar days for dashboard figures ("received today", date filters) are
// business days in Sri Lanka, not the server's or UTC's day.
export const BUSINESS_TIME_ZONE = "Asia/Colombo";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// UTC offset of the zone at `date`, in minutes (Colombo: +330).
function zoneOffsetMinutes(date, timeZone) {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(date)
        .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    const match = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
    if (!match) return 0;
    const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
    return match[1] === "-" ? -minutes : minutes;
}

// "YYYY-MM-DD" of `date` in the business time zone.
export function businessDateOf(date = new Date(), timeZone = BUSINESS_TIME_ZONE) {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Is this a real calendar date in YYYY-MM-DD form?
export function isValidBusinessDate(value) {
    const match = typeof value === "string" && value.match(DATE_PATTERN);
    if (!match) return false;
    const [, y, m, d] = match.map(Number);
    const check = new Date(Date.UTC(y, m - 1, d));
    return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

// The UTC instants where business day `ymd` starts and the next one starts.
export function businessDayRange(ymd, timeZone = BUSINESS_TIME_ZONE) {
    if (!isValidBusinessDate(ymd)) throw new RangeError("Expected a date as YYYY-MM-DD");
    const [y, m, d] = ymd.split("-").map(Number);
    const localMidnightAsUtc = Date.UTC(y, m - 1, d);
    const start = new Date(localMidnightAsUtc - zoneOffsetMinutes(new Date(localMidnightAsUtc), timeZone) * 60_000);
    const nextMidnightAsUtc = Date.UTC(y, m - 1, d + 1);
    const end = new Date(nextMidnightAsUtc - zoneOffsetMinutes(new Date(nextMidnightAsUtc), timeZone) * 60_000);
    return { start, end };
}

// ---- calendar arithmetic on business dates ("YYYY-MM-DD"; pure dates, no time zone involved)

const ymdOf = (utcDate) => utcDate.toISOString().slice(0, 10);
const partsOf = (ymd) => ymd.split("-").map(Number);

// `ymd` plus `days` calendar days (negative: earlier).
export function addBusinessDays(ymd, days) {
    const [y, m, d] = partsOf(ymd);
    return ymdOf(new Date(Date.UTC(y, m - 1, d + days)));
}

// `ymd` plus `months` calendar months, clamped to the end of a shorter month (Jan 31 + 1 -> Feb 28/29).
export function addBusinessMonths(ymd, months) {
    const [y, m, d] = partsOf(ymd);
    const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
    return ymdOf(new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay))));
}

// The last calendar day of its month (28, 29, 30 or 31).
export const isLastDayOfMonth = (ymd) => addBusinessDays(ymd, 1).slice(5, 7) !== ymd.slice(5, 7);

// Working days: Monday to Friday. No public-holiday list is kept.
export function isWorkingDay(ymd) {
    const [y, m, d] = partsOf(ymd);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return weekday !== 0 && weekday !== 6;
}

// The closest working day strictly before `ymd`.
export function previousWorkingDay(ymd) {
    let day = addBusinessDays(ymd, -1);
    while (!isWorkingDay(day)) day = addBusinessDays(day, -1);
    return day;
}

// The instant of "HH:MM" business time on business day `ymd`.
export function businessTimeOn(ymd, hhmm, timeZone = BUSINESS_TIME_ZONE) {
    const [h, min] = hhmm.split(":").map(Number);
    return new Date(businessDayRange(ymd, timeZone).start.getTime() + (h * 60 + min) * 60_000);
}
