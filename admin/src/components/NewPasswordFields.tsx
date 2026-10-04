import { useState } from "react";
import { FormField, fieldA11y } from "./Form";
import { Icon } from "./Icon";
import { inputClass } from "./ui";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, confirmPasswordError, newPasswordError } from "./validation";

export type NewPasswordErrors = { password?: string | null; confirm?: string | null };

export function validateNewPassword(password: string, confirm: string): NewPasswordErrors {
    return { password: newPasswordError(password), confirm: confirmPasswordError(password, confirm) };
}

export const hasNewPasswordErrors = (errors: NewPasswordErrors) => Boolean(errors.password || errors.confirm);

// New password + confirmation (reset password and invitation setup). One
// show/hide toggle reveals both. Errors are cleared as soon as the value is
// valid; `errors` comes from validateNewPassword at submit.
export function NewPasswordFields({
    passwordId,
    password,
    confirm,
    errors,
    onChange,
    confirmPlaceholder = "Re-enter password",
}: {
    passwordId: string;
    password: string;
    confirm: string;
    errors: NewPasswordErrors;
    onChange: (next: { password: string; confirm: string; errors: NewPasswordErrors }) => void;
    confirmPlaceholder?: string;
}) {
    const [show, setShow] = useState(false);
    const update = (nextPassword: string, nextConfirm: string) => {
        const fresh = validateNewPassword(nextPassword, nextConfirm);
        onChange({
            password: nextPassword,
            confirm: nextConfirm,
            // Only errors already on screen are re-checked (and cleared once valid).
            errors: { password: errors.password ? fresh.password : null, confirm: errors.confirm ? fresh.confirm : null },
        });
    };
    const type = show ? "text" : "password";

    return (
        <>
            <FormField
                id={passwordId}
                label="New Password"
                required
                help={`Use ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters. A longer passphrase is easier to remember and harder to guess.`}
                error={errors.password}
            >
                <div className="relative">
                    <Icon name="lock" className="pointer-events-none absolute left-3 top-3 size-4 text-ink-subtle" />
                    <input
                        {...fieldA11y(passwordId, errors.password)}
                        type={type}
                        value={password}
                        onChange={(e) => update(e.target.value, confirm)}
                        placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                        required
                        minLength={MIN_PASSWORD_LENGTH}
                        maxLength={MAX_PASSWORD_LENGTH}
                        autoComplete="new-password"
                        className={inputClass(Boolean(errors.password), { padding: "pl-9 pr-10" })}
                    />
                    <button
                        type="button"
                        onClick={() => setShow((value) => !value)}
                        className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded text-ink-subtle hover:bg-canvas-muted hover:text-ink"
                        tabIndex={-1}
                    >
                        <Icon name={show ? "visibility_off" : "visibility"} className="size-4" />
                        <span className="sr-only">{show ? "Hide password" : "Show password"}</span>
                    </button>
                </div>
            </FormField>

            <FormField id="confirm-password" label="Confirm Password" required error={errors.confirm}>
                <div className="relative">
                    <Icon name="lock" className="pointer-events-none absolute left-3 top-3 size-4 text-ink-subtle" />
                    <input
                        {...fieldA11y("confirm-password", errors.confirm)}
                        type={type}
                        value={confirm}
                        onChange={(e) => update(password, e.target.value)}
                        placeholder={confirmPlaceholder}
                        required
                        minLength={MIN_PASSWORD_LENGTH}
                        maxLength={MAX_PASSWORD_LENGTH}
                        autoComplete="new-password"
                        className={inputClass(Boolean(errors.confirm), { padding: "pl-9 pr-3" })}
                    />
                </div>
            </FormField>
        </>
    );
}
