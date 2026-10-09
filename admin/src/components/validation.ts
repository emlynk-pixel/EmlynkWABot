// Client-side checks for the admin forms. They mirror the backend rules
// (src/services/userAccountService.js; passwords: the Supabase project policy)
// so a value the form accepts is one the server accepts too; the server
// still validates everything. Each returns an error message or null.

export const MAX_EMAIL_LENGTH = 254;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_NAME_LENGTH = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailError(value: string, { required = "Enter your email address." } = {}): string | null {
    const trimmed = value.trim();
    if (!trimmed) return required;
    if (trimmed.length > MAX_EMAIL_LENGTH) return `Email must be at most ${MAX_EMAIL_LENGTH} characters.`;
    if (!EMAIL_PATTERN.test(trimmed)) return "Enter a valid email address, like name@example.com.";
    return null;
}

export function newPasswordError(value: string): string | null {
    if (!value) return "Enter a new password.";
    if (value.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
    if (value.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`;
    return null;
}

export function confirmPasswordError(password: string, confirm: string): string | null {
    if (!confirm) return "Enter the password again.";
    return confirm === password ? null : "Passwords do not match.";
}

export function nameError(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return "Enter the person's full name.";
    if (trimmed.length > MAX_NAME_LENGTH) return `Name must be at most ${MAX_NAME_LENGTH} characters.`;
    return null;
}
