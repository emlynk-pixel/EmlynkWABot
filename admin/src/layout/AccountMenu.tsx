import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { ROLE_LABELS, type Role } from "../auth/roles";
import { Icon } from "../components/Icon";

function initials(name: string, email: string) {
    return (name.trim() || email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "A";
}

// The account card at the foot of the sidebar: who is signed in, with Sign out
// in a menu that opens upward. The icon rail shows only the avatar.
export function AccountMenu({ railOnly }: { railOnly: boolean }) {
    const { user, signOut } = useAuth();
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        const closeOutside = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            setOpen(false);
            triggerRef.current?.focus();
        };
        document.addEventListener("mousedown", closeOutside);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("mousedown", closeOutside);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [open]);

    if (!user) return null;
    const role = ROLE_LABELS[user.role as Role] ?? user.role;

    return (
        <div className="relative" ref={containerRef}>
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                aria-label={`Account: ${user.name}`}
                title={railOnly ? user.name : undefined}
                className={[
                    "flex items-center gap-2 rounded-md text-left transition-colors hover:bg-sidebar-hover hover:text-sidebar-text-active",
                    open ? "bg-sidebar-hover text-sidebar-text-active" : "",
                    railOnly ? "size-8 justify-center" : "h-12 w-full px-2",
                ].join(" ")}
            >
                <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-border text-label-sm text-sidebar-text-active">
                    {initials(user.name, user.email)}
                </span>
                <span className={railOnly ? "sr-only" : "grid min-w-0 flex-1"}>
                    <span data-testid="admin-name" className="truncate text-label-md">{user.name}</span>
                    <span className="truncate text-label-sm text-sidebar-text-muted">{role}</span>
                </span>
                {!railOnly && <Icon name="unfold_more" />}
            </button>

            {open && (
                <div className="absolute bottom-full left-0 z-50 mb-2 w-56 rounded-lg border border-border bg-surface p-1 text-ink shadow-popover">
                    <div className="px-2 py-1.5">
                        <p className="truncate text-label-md">{user.name}</p>
                        <p className="truncate text-label-sm text-ink-muted">{user.email}</p>
                    </div>
                    <div className="-mx-1 my-1 h-px bg-border" />
                    <button
                        type="button"
                        onClick={signOut}
                        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-body-sm hover:bg-canvas"
                    >
                        <Icon name="logout" />
                        Sign out
                    </button>
                </div>
            )}
        </div>
    );
}
