import { TextArea, TextInput, VerifiedValue } from "../../components/inputs";
import { useLanguage } from "../../i18n/useLanguage";
import { bind, type StepProps } from "../binding";
import { MAX_LENGTH } from "../validation";

// Contact & Location Details. The WhatsApp number is the verified one,
// shown read-only. Email and phone numbers are never changed to capitals
// ("n/a" in the alternative phone is still sent as "N/A": model.ts).
export function ContactStep(props: StepProps & { whatsappNumber: string }) {
    const { t } = useLanguage();
    return (
        <div className="field-grid">
            <div className="span-2">
                <TextArea {...bind(props, "contact.address")} label={t("f.address")} uppercase maxLength={MAX_LENGTH.address} rows={2} />
            </div>
            <TextInput {...bind(props, "contact.city")} label={t("f.city")} hint={t("hint.na")} uppercase maxLength={MAX_LENGTH.text} />
            <TextInput {...bind(props, "contact.district")} label={t("f.district")} uppercase maxLength={MAX_LENGTH.text} />
            <TextInput {...bind(props, "contact.dsDivision")} label={t("f.dsDivision")} uppercase maxLength={MAX_LENGTH.text} />
            <TextInput {...bind(props, "contact.gnDivision")} label={t("f.gnDivision")} uppercase maxLength={MAX_LENGTH.text} />
            <VerifiedValue id="contact-whatsapp" label={t("f.whatsapp")} value={props.whatsappNumber || "—"} />
            <TextInput {...bind(props, "contact.alternativePhone")} label={t("f.alternativePhone")} hint={`${t("hint.phone")} ${t("hint.na")}`} type="tel" inputMode="tel" maxLength={20} />
            <div className="span-2">
                <TextInput {...bind(props, "contact.email")} label={t("f.email")} hint={t("hint.email")} type="email" inputMode="email" maxLength={254} />
            </div>
        </div>
    );
}
