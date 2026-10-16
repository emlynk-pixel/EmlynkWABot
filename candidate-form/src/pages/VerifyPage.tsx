import { useState, type FormEvent } from "react";
import { verifyCandidate, verifyFailureOf, type VerifyFailure } from "../api/candidateDetails";
import { TextInput } from "../components/inputs";
import type { MessageKey } from "../i18n/translations";
import { useLanguage, type Message } from "../i18n/useLanguage";
import { setSession } from "../session/tokenStore";

// Step 1: Passport Number + WhatsApp Number. The same rules as the server
// (which stays the authority): passport letters and digits (spaces and
// hyphens ignored), at most 20; WhatsApp "+" then 8 to 15 digits.
const PASSPORT_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const WHATSAPP_PATTERN = /^\+[1-9]\d{7,14}$/;

type FieldErrors = { passportNumber?: Message; whatsappNumber?: Message };

function validate(passportNumber: string, whatsappNumber: string): FieldErrors {
    const errors: FieldErrors = {};
    if (!PASSPORT_PATTERN.test(passportNumber.trim().replace(/[\s-]/g, ""))) errors.passportNumber = { key: "verify.passportInvalid" };
    if (!WHATSAPP_PATTERN.test(whatsappNumber.trim())) errors.whatsappNumber = { key: "verify.whatsappInvalid" };
    return errors;
}

// A fixed message for every failure, in the current language; the server's
// own text is never shown.
const FAILURE_MESSAGE: Record<VerifyFailure, MessageKey> = {
    failed: "verify.failed",
    invalid: "verify.invalidInput",
    rateLimited: "verify.rateLimited",
    unavailable: "verify.unavailable",
    network: "error.network",
    generic: "error.generic",
};

export function VerifyPage({ onVerified, notice }: { onVerified: (expiresAt: string) => void; notice?: Message }) {
    const { t } = useLanguage();
    const [passportNumber, setPassportNumber] = useState("");
    const [whatsappNumber, setWhatsappNumber] = useState("");
    const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
    const [failure, setFailure] = useState<VerifyFailure | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (busy) return;
        const errors = validate(passportNumber, whatsappNumber);
        setFieldErrors(errors);
        setFailure(null);
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
            setFailure(verifyFailureOf(error));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form className="panel" onSubmit={submit} noValidate aria-labelledby="verify-title">
            <h1 id="verify-title">{t("verify.title")}</h1>
            <p className="lead">{t("verify.lead")}</p>
            {notice && !failure && <p className="notice" role="status">{t(notice.key, notice.params)}</p>}
            <TextInput
                id="passportNumber"
                label={t("verify.passport")}
                help={t("verify.passportHelp")}
                required
                value={passportNumber}
                onChange={setPassportNumber}
                error={fieldErrors.passportNumber}
                disabled={busy}
                maxLength={30}
                autoCapitalize="characters"
            />
            <TextInput
                id="whatsappNumber"
                label={t("verify.whatsapp")}
                hint={t("verify.whatsappHint")}
                required
                value={whatsappNumber}
                onChange={setWhatsappNumber}
                error={fieldErrors.whatsappNumber}
                disabled={busy}
                inputMode="tel"
                placeholder="+94771234567"
                maxLength={20}
            />
            {failure && <p className="form-error" role="alert"><span aria-hidden="true">! </span>{t(FAILURE_MESSAGE[failure])}</p>}
            <button type="submit" className="primary" disabled={busy}>{busy ? t("verify.submitting") : t("verify.submit")}</button>
        </form>
    );
}
