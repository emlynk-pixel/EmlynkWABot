import { Field } from "../../components/Field";
import { FormSection } from "../../components/FormSection";
import { TextArea, TextInput, VerifiedValue } from "../../components/inputs";
import { useLanguage } from "../../i18n/useLanguage";
import { bind, type StepProps } from "../binding";
import { isNotApplicableFor } from "../model";
import { findCity, MAX_CITY_LENGTH } from "../romania";
import { MAX_LENGTH } from "../validation";

// Contact & Location Details. The WhatsApp number is the verified one,
// shown read-only. Email and phone numbers are never changed to capitals
// ("n/a" in the alternative phone is still sent as "N/A": model.ts).
// City in Romania suggests the listed cities as the candidate types (any other
// city can still be typed; Romanian letters are kept as typed). Its distance to
// Bucharest is APPROXIMATE (straight line, not by road), shown from the server's
// list only for a listed city, and is never typed or sent: the server works it out.
export function ContactStep(props: StepProps & { whatsappNumber: string }) {
    const { t } = useLanguage();
    const cities = props.romanianCities ?? [];
    const cityInRomania = props.data.contact.cityInRomania;
    const city = findCity(cities, cityInRomania);
    const distance = city
        ? t("distance.approx", { km: String(city.distanceKm) })
        : !cityInRomania.trim()
            ? "—"
            : isNotApplicableFor("contact.cityInRomania", cityInRomania) ? t("distance.notApplicable") : t("distance.notListed");
    return (
        <>
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
            <FormSection title={t("section.romania")}>
                <div className="field-grid">
                    <TextInput
                        {...bind(props, "contact.cityInRomania")}
                        label={t("f.cityInRomania")}
                        hint={t("hint.cityInRomania")}
                        placeholder={t("placeholder.cityInRomania")}
                        maxLength={MAX_CITY_LENGTH}
                        suggestions={cities.map((listed) => listed.name)}
                    />
                    <Field id="contact-distanceToBucharest" label={t("f.distanceToBucharest")} hint={t("hint.distance")}>
                        {() => (
                            <div className="derived-value">
                                <input id="contact-distanceToBucharest" name="contact-distanceToBucharest" value={distance} readOnly aria-readonly="true" aria-describedby="contact-distanceToBucharest-hint" />
                            </div>
                        )}
                    </Field>
                </div>
            </FormSection>
        </>
    );
}
