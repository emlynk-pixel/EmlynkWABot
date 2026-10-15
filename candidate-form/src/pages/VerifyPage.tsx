import { useState, type FormEvent } from "react";
import { verifyCandidate } from "../api/candidateDetails";
import { ApiError } from "../api/client";
import { TextField } from "../components/TextField";
import { setSession } from "../session/tokenStore";

// Task 1: verification only. The same rules as the server (which stays the
// authority): passport letters and digits (spaces and hyphens ignored), at
// most 20; WhatsApp "+" then 8 to 15 digits.
const PASSPORT_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const WHATSAPP_PATTERN = /^\+[1-9]\d{7,14}$/;

type FieldErrors = { passportNumber?: string; whatsappNumber?: string };

function validate(passportNumber: string, whatsappNumber: string): FieldErrors {
    const errors: FieldErrors = {};
    if (!PASSPORT_PATTERN.test(passportNumber.trim().replace(/[\s-]/g, ""))) {
        errors.passportNumber = "Enter your passport number using letters and numbers only.";
    }
    if (!WHATSAPP_PATTERN.test(whatsappNumber.trim())) {
        errors.whatsappNumber = "Enter your WhatsApp number starting with + and your country code, for example +94771234567.";
    }
    return errors;
}

export function VerifyPage({ onVerified }: { onVerified: (expiresAt: string) => void }) {
    const [passportNumber, setPassportNumber] = useState("");
    const [whatsappNumber, setWhatsappNumber] = useState("");
    const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
    const [formError, setFormError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (busy) return;
        const errors = validate(passportNumber, whatsappNumber);
        setFieldErrors(errors);
        setFormError(null);
        if (errors.passportNumber || errors.whatsappNumber) return;

        setBusy(true);
        try {
            const result = await verifyCandidate({ passportNumber: passportNumber.trim(), whatsappNumber: whatsappNumber.trim() });
            setSession(result.token, result.expiresAt);
            // Nothing typed stays on screen after a successful verification.
            setPassportNumber("");
            setWhatsappNumber("");
            onVerified(result.expiresAt);
        } catch (error) {
            setFormError(error instanceof ApiError ? error.message : "Something went wrong. Please try again later.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <form className="card" onSubmit={submit} noValidate>
            <h1>Verify your details</h1>
            <p className="lead">Enter the passport number and WhatsApp number you registered with.</p>
            <TextField
                id="passportNumber"
                label="Passport Number"
                value={passportNumber}
                onChange={setPassportNumber}
                error={fieldErrors.passportNumber}
                disabled={busy}
                maxLength={30}
            />
            <TextField
                id="whatsappNumber"
                label="WhatsApp Number"
                hint="Start with + and your country code, for example +94771234567."
                value={whatsappNumber}
                onChange={setWhatsappNumber}
                error={fieldErrors.whatsappNumber}
                disabled={busy}
                inputMode="tel"
                placeholder="+94771234567"
                maxLength={20}
            />
            {formError && <p className="form-error" role="alert">{formError}</p>}
            <button type="submit" disabled={busy}>{busy ? "Verifying…" : "Verify"}</button>
        </form>
    );
}
