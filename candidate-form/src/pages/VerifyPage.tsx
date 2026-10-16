import { useState, type FormEvent } from "react";
import { verifyCandidate, verifyFailureOf, type VerifyFailure } from "../api/candidateDetails";
import { TextInput } from "../components/inputs";
import type { MessageKey } from "../i18n/translations";
import { useLanguage, type Message } from "../i18n/useLanguage";
import { setSession } from "../session/tokenStore";

// Step 1: the candidate's own Passport Number + NIC, checked together with
// the share link they opened. The same input rules as the server (which stays
// the authority): passport letters and digits (spaces and hyphens ignored),
// at most 20; NIC 9 digits + V/X, or 12 digits (spaces ignored).
const PASSPORT_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const NIC_PATTERN = /^(\d{9}[VX]|\d{12})$/;

type FieldErrors = { passportNumber?: Message; nic?: Message };

const canonicalNic = (value: string) => value.trim().replace(/\s/g, "").toUpperCase();

function validate(passportNumber: string, nic: string): FieldErrors {
    const errors: FieldErrors = {};
    if (!PASSPORT_PATTERN.test(passportNumber.trim().replace(/[\s-]/g, ""))) errors.passportNumber = { key: "verify.passportInvalid" };
    if (!NIC_PATTERN.test(canonicalNic(nic))) errors.nic = { key: "verify.nicInvalid" };
    return errors;
}

// A fixed message for every failure, in the current language; the server's
// own text is never shown. ("submitted" is handled by the page above.)
const FAILURE_MESSAGE: Record<Exclude<VerifyFailure, "submitted">, MessageKey> = {
    failed: "verify.failed",
    invalid: "verify.invalidInput",
    rateLimited: "verify.rateLimited",
    unavailable: "verify.unavailable",
    network: "error.network",
    generic: "error.generic",
};

export function VerifyPage({ linkSecret, onVerified, onAlreadySubmitted, notice }: {
    linkSecret: string;
    onVerified: (expiresAt: string) => void;
    onAlreadySubmitted: () => void;
    notice?: Message;
}) {
    const { t } = useLanguage();
    const [passportNumber, setPassportNumber] = useState("");
    const [nic, setNic] = useState("");
    const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
    const [failure, setFailure] = useState<Exclude<VerifyFailure, "submitted"> | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (busy) return;
        const errors = validate(passportNumber, nic);
        setFieldErrors(errors);
        setFailure(null);
        if (errors.passportNumber || errors.nic) return;

        setBusy(true);
        try {
            const result = await verifyCandidate({ linkSecret, passportNumber: passportNumber.trim(), nic: nic.trim() });
            setSession(result.token, result.expiresAt);
            // Nothing typed stays on screen after a successful verification.
            setPassportNumber("");
            setNic("");
            onVerified(result.expiresAt);
        } catch (error) {
            const kind = verifyFailureOf(error);
            if (kind === "submitted") {
                onAlreadySubmitted();
                return;
            }
            setFailure(kind);
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
                uppercase
            />
            <TextInput
                id="nic"
                label={t("verify.nic")}
                hint={t("verify.nicHint")}
                required
                value={nic}
                onChange={setNic}
                error={fieldErrors.nic}
                disabled={busy}
                maxLength={20}
                uppercase
            />
            {failure && <p className="form-error" role="alert"><span aria-hidden="true">! </span>{t(FAILURE_MESSAGE[failure])}</p>}
            <button type="submit" className="primary" disabled={busy}>{busy ? t("verify.submitting") : t("verify.submit")}</button>
        </form>
    );
}
