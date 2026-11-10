import { useId, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { ActionDialog, DialogError, primaryButton, secondaryButton } from "./Dialog";
import { inputClass } from "./ui";

// The server's limit (userAccountService.js MAX_NAME_LENGTH).
export const MAX_USER_NAME_LENGTH = 100;

type EditNameProps = {
    currentName: string;
    // Sends the trimmed name; the form closes when it resolves, and shows the server's message when it fails.
    onSave: (name: string) => Promise<void>;
    onClose: () => void;
};

// The name field with Save / Cancel (only the name changes). `onBusy`: tells the container while saving.
export function EditNameForm({ currentName, onSave, onClose, onBusy }: EditNameProps & { onBusy?: (busy: boolean) => void }) {
    const inputId = useId();
    const [name, setName] = useState(currentName);
    const [busy, setBusyState] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const trimmed = name.trim().replace(/\s+/g, " ");
    const setBusy = (value: boolean) => {
        setBusyState(value);
        onBusy?.(value);
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!trimmed) {
            setError("Enter a name.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await onSave(trimmed);
            setBusy(false);
            onClose();
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "The name could not be saved.");
            setBusy(false);
        }
    };

    return (
        <form onSubmit={submit} noValidate>
            <label htmlFor={inputId} className="mb-1 block text-label-sm text-ink-muted">Name<span className="text-critical"> *</span></label>
            <input id={inputId} value={name} maxLength={MAX_USER_NAME_LENGTH} autoFocus disabled={busy} onChange={(event) => setName(event.target.value)} className={inputClass(Boolean(error))} />
            <DialogError message={error} />
            <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={onClose} disabled={busy} className={secondaryButton}>Cancel</button>
                <button type="submit" disabled={busy || !trimmed || trimmed === currentName} className={primaryButton}>{busy ? "Saving…" : "Save"}</button>
            </div>
        </form>
    );
}

// The same form in a centred dialog (Settings > Change Roles).
export function EditNameDialog({ title = "Edit name", ...props }: EditNameProps & { title?: string }) {
    const [busy, setBusy] = useState(false);
    return (
        <ActionDialog title={title} busy={busy} onClose={props.onClose}>
            <EditNameForm {...props} onBusy={setBusy} />
        </ActionDialog>
    );
}
