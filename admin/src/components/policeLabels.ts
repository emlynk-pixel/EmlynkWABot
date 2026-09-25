import type { PoliceCountdown, PoliceStatus } from "../api/admin";

// Police Workflow statuses (backend: src/services/policeCountdownService.js),
// most urgent first.
export const POLICE_STATUSES: { status: PoliceStatus; label: string; description: string }[] = [
    { status: "OVERDUE", label: "Overdue", description: "More than 21 days since the slip was submitted, no final report" },
    { status: "DUE_TODAY", label: "Due today", description: "21 days since the slip was submitted" },
    { status: "DUE_SOON", label: "Due soon", description: "1 to 7 days left" },
    { status: "PENDING", label: "Pending", description: "More than 7 days left" },
    { status: "DATE_MISSING", label: "Date missing", description: "A police slip exists, but its submitted date is not known yet" },
    { status: "NOT_UPLOADED", label: "Not uploaded", description: "No police slip received" },
    { status: "COMPLETED", label: "Completed", description: "A verified police report is on file" },
];

export function policeStatusLabel(status: PoliceStatus): string {
    return POLICE_STATUSES.find((s) => s.status === status)?.label ?? status;
}

// "5 days left", "Due today", "3 days overdue"; "—" without a running countdown.
export function daysLeftLabel(countdown: Pick<PoliceCountdown, "daysRemaining">): string {
    const days = countdown.daysRemaining;
    if (days === null) return "—";
    if (days === 0) return "Due today";
    if (days > 0) return `${days} ${days === 1 ? "day" : "days"} left`;
    return `${-days} ${days === -1 ? "day" : "days"} overdue`;
}
