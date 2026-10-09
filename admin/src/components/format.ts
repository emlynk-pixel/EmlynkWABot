// Display helpers. Dates are shown in Sri Lanka time, the same business day
// the backend uses for "received today" and the date filters.
export const BUSINESS_TIME_ZONE = "Asia/Colombo";

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
    PASSPORT: "Passport",
    POLICE_SLIP: "Police slip",
    POLICE_REPORT: "Police report",
    MEDICAL: "Medical",
    UNKNOWN: "Unknown",
    // Uploaded from Admin > Candidates.
    NIC: "NIC",
    SKILL_VIDEO: "Skill video",
    SCAN: "Scan",
    VISA_SUBMISSION: "Visa submission",
};

export function documentTypeLabel(type: string): string {
    return DOCUMENT_TYPE_LABELS[type] ?? humanize(type);
}

// "MANUAL_REVIEW" -> "Manual review"
export function humanize(code: string): string {
    const text = code.toLowerCase().replace(/_/g, " ");
    return text.charAt(0).toUpperCase() + text.slice(1);
}

const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: BUSINESS_TIME_ZONE, day: "2-digit", month: "short", year: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: BUSINESS_TIME_ZONE, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
const numberFormat = new Intl.NumberFormat("en-GB");

export function formatDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "—" : dateFormat.format(date);
}

// A calendar day "YYYY-MM-DD" (e.g. a police slip date), shown as that day.
export function formatDay(ymd: string | null | undefined): string {
    return ymd ? formatDate(`${ymd}T12:00:00+05:30`) : "—";
}

// Today in Sri Lanka as "YYYY-MM-DD" (the latest date a slip can carry).
export function todayInSriLanka(now: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: BUSINESS_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false });

// "14:30", Sri Lanka time.
export function formatTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "—" : timeFormat.format(date);
}

// Now in Sri Lanka, as the values of a date and a time input.
export function nowInSriLanka(now: Date = new Date()): { date: string; time: string } {
    return { date: todayInSriLanka(now), time: timeFormat.format(now) };
}

// A date and time entered in Sri Lanka ("2026-10-02", "14:30") as an ISO
// string with its offset. Sri Lanka has no daylight saving: always +05:30.
export function sriLankaDateTime(date: string, time: string): string {
    return `${date}T${time}:00+05:30`;
}

export function formatDateTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "—" : dateTimeFormat.format(date);
}

export function formatNumber(value: number): string {
    return numberFormat.format(value);
}

// Document IDs are UUIDs; the first 8 characters identify them in tables.
export function shortId(id: string): string {
    return id.slice(0, 8).toUpperCase();
}

export function formatFileSize(bytes: number | null): string {
    if (bytes === null) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
