// Shared by Dialog.tsx and ConfirmDialog.tsx (they must not import each other).
export const buttonBase = "h-9 rounded px-4 text-label-md disabled:cursor-not-allowed disabled:opacity-60";
export const primaryButton = `${buttonBase} bg-primary text-on-primary hover:opacity-90`;
export const secondaryButton = `${buttonBase} border border-border-strong bg-surface text-ink-soft hover:border-border-focus hover:bg-canvas`;
export const dangerButton = `${buttonBase} border border-critical-border bg-surface text-critical hover:bg-critical-bg`;
export const dangerSolidButton = `${buttonBase} bg-critical text-on-critical hover:opacity-90`;

export function DialogError({ message }: { message: string | null }) {
    return message ? <p role="alert" className="mt-3 rounded border border-critical-border bg-critical-bg px-3 py-2 text-body-sm text-critical">{message}</p> : null;
}
