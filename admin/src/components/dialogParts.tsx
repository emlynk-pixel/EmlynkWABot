// Shared by Dialog.tsx and ConfirmDialog.tsx (they must not import each other).
export const buttonBase = "h-8 rounded-lg px-2.5 text-label-md transition-all active:translate-y-px disabled:pointer-events-none disabled:opacity-50";
export const primaryButton = `${buttonBase} bg-primary text-on-primary hover:bg-primary-hover`;
export const secondaryButton = `${buttonBase} border border-border-strong bg-surface text-ink-soft hover:border-border-focus hover:bg-canvas`;
export const dangerButton = `${buttonBase} bg-critical-bg text-critical hover:bg-critical-border`;
// Destructive actions are a tint, never a solid red.
export const dangerSolidButton = dangerButton;

export function DialogError({ message }: { message: string | null }) {
    return message ? <p role="alert" className="mt-3 rounded-lg border border-critical-border bg-critical-bg px-3 py-2 text-body-sm text-critical">{message}</p> : null;
}
