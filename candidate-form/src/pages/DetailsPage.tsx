import { useEffect, useMemo, useState, type FormEvent } from "react";
import { DateInput, SelectInput, TextArea, TextInput, YesNo } from "../components/inputs";
import { FormSection } from "../components/FormSection";
import { SizeField } from "../components/SizeField";
import {
    DETAIL_FIELDS,
    EARLIEST_DATE,
    emptyDetails,
    MARITAL_STATUSES,
    MAX_LENGTH,
    PANT_SIZE_PRESETS,
    SHOE_SIZE_PRESETS,
    showsChildren,
    showsWife,
    todayInSriLanka,
    TSHIRT_SIZES,
    validateDetails,
    type DetailField,
    type DetailsForm,
} from "../details/model";
import { useLanguage } from "../i18n/useLanguage";
import { getSession } from "../session/tokenStore";

// How often the page checks that the in-memory session is still valid.
const SESSION_CHECK_MS = 10_000;

type Outcome = "invalid" | "checked" | null;

// Step 2: the candidate's Additional Details (the 19 fields only).
//
// Task 2: the secure read and save (Task 3) do not exist yet, so the form
// starts empty, says plainly that nothing is saved, and "Save details" only
// checks the entries with the server's rules. It never claims to have saved.
// Everything typed lives in this component's memory and is gone when the
// page is left, like the session itself.
export function DetailsPage({ expiresAt, onFinish, onSessionEnded }: { expiresAt: string; onFinish: () => void; onSessionEnded: () => void }) {
    const { t, language } = useLanguage();
    const [form, setForm] = useState<DetailsForm>(emptyDetails);
    const [initial] = useState<DetailsForm>(emptyDetails);
    const [otherSize, setOtherSize] = useState({ pantSize: false, shoeSize: false });
    // Errors are shown after the first "Save details", then kept up to date
    // as the candidate corrects them.
    const [checked, setChecked] = useState(false);
    const [outcome, setOutcome] = useState<Outcome>(null);
    const today = todayInSriLanka();

    // The token is only in memory: once it is gone (expired, or the page was
    // reloaded) the candidate goes back to verification.
    useEffect(() => {
        if (!getSession()) {
            onSessionEnded();
            return undefined;
        }
        const timer = window.setInterval(() => {
            if (!getSession()) onSessionEnded();
        }, SESSION_CHECK_MS);
        return () => window.clearInterval(timer);
    }, [onSessionEnded]);

    const errors = useMemo(() => (checked ? validateDetails(form, today) : {}), [checked, form, today]);
    const unsaved = hasChanges(form, initial);

    const set = (field: DetailField) => (value: string) => {
        setForm((previous) => ({ ...previous, [field]: value }));
        setOutcome(null);
    };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        setChecked(true);
        const found = validateDetails(form, today);
        setOutcome(Object.keys(found).length ? "invalid" : "checked");
        if (Object.keys(found).length) {
            // Take the candidate to the first field to fix, in form order (a
            // custom size has its own box).
            const first = DETAIL_FIELDS.find((field) => found[field]);
            if (first) window.requestAnimationFrame(() => (document.getElementById(`${first}Other`) ?? document.getElementById(first))?.focus());
        }
    };

    const time = new Date(expiresAt).toLocaleTimeString(language === "si" ? "si-LK" : "en-GB", { hour: "2-digit", minute: "2-digit" });
    const text = (field: DetailField, extra: { required?: boolean; help?: string; maxLength?: number } = {}) => (
        <TextInput
            id={field}
            label={t(`field.${field}` as const)}
            value={form[field]}
            onChange={set(field)}
            error={errors[field]}
            maxLength={extra.maxLength ?? MAX_LENGTH.name}
            required={extra.required}
            help={extra.help}
            autoCapitalize="words"
        />
    );
    const date = (field: DetailField) => (
        <DateInput id={field} label={t(`field.${field}` as const)} value={form[field]} onChange={set(field)} error={errors[field]} min={EARLIEST_DATE} max={today} />
    );

    return (
        <form className="panel" onSubmit={submit} noValidate aria-labelledby="details-title">
            <p className="success" role="status"><span aria-hidden="true">✓ </span>{t("details.verified")}</p>
            <h1 id="details-title">{t("details.title")}</h1>
            <p className="lead">{t("details.lead")}</p>
            <p className="notice">{t("details.saveNotice")} {t("details.sessionEnds", { time })}</p>

            <FormSection title={t("section.personal")}>
                {text("nameAsInPassport", { help: t("help.nameAsInPassport") })}
                <TextArea id="permanentAddress" label={t("field.permanentAddress")} value={form.permanentAddress} onChange={set("permanentAddress")} error={errors.permanentAddress} maxLength={MAX_LENGTH.address} />
                {date("birthday")}
            </FormSection>

            <FormSection title={t("section.sizes")}>
                <SelectInput
                    id="tshirtSize"
                    label={t("field.tshirtSize")}
                    value={form.tshirtSize}
                    onChange={set("tshirtSize")}
                    options={TSHIRT_SIZES.map((size) => ({ value: size, label: size }))}
                    error={errors.tshirtSize}
                />
                <SizeField
                    id="pantSize"
                    label={t("field.pantSize")}
                    otherLabel={t("field.pantSizeOther")}
                    help={t("help.pantSize")}
                    presets={PANT_SIZE_PRESETS}
                    value={form.pantSize}
                    other={otherSize.pantSize}
                    onChange={set("pantSize")}
                    onOtherChange={(other) => setOtherSize((previous) => ({ ...previous, pantSize: other }))}
                    error={errors.pantSize}
                />
                <SizeField
                    id="shoeSize"
                    label={t("field.shoeSize")}
                    otherLabel={t("field.shoeSizeOther")}
                    help={t("help.shoeSize")}
                    presets={SHOE_SIZE_PRESETS}
                    value={form.shoeSize}
                    other={otherSize.shoeSize}
                    onChange={set("shoeSize")}
                    onOtherChange={(other) => setOtherSize((previous) => ({ ...previous, shoeSize: other }))}
                    error={errors.shoeSize}
                />
            </FormSection>

            <FormSection title={t("section.father")}>
                <YesNo id="fatherAlive" label={t("field.fatherAlive")} value={form.fatherAlive} onChange={set("fatherAlive")} />
                {text("fatherFullName", { required: form.fatherAlive === "yes", help: t("help.parentName") })}
                {date("fatherBirthday")}
            </FormSection>

            <FormSection title={t("section.mother")}>
                <YesNo id="motherAlive" label={t("field.motherAlive")} value={form.motherAlive} onChange={set("motherAlive")} />
                {text("motherFullName", { required: form.motherAlive === "yes", help: t("help.parentName") })}
                {date("motherBirthday")}
            </FormSection>

            <FormSection title={t("section.family")}>
                <SelectInput
                    id="maritalStatus"
                    label={t("field.maritalStatus")}
                    value={form.maritalStatus}
                    onChange={set("maritalStatus")}
                    options={MARITAL_STATUSES.map((status) => ({ value: status, label: t(`marital.${status}`) }))}
                    error={errors.maritalStatus}
                />
                {/* Hidden fields keep what was typed (switching back shows it again);
                    they are only left out of what would be sent (toPayload). */}
                {showsWife(form) && (
                    <>
                        {text("wifeFullName", { required: true })}
                        {date("wifeBirthday")}
                    </>
                )}
                {showsChildren(form) && (
                    <div className="subgroup" role="group" aria-labelledby="children-note">
                        <p id="children-note" className="section-note">{t("help.children")}</p>
                        {text("child1Name")}
                        {text("child2Name")}
                        {text("child3Name")}
                    </div>
                )}
            </FormSection>

            <FormSection title={t("section.skills")}>
                <TextArea
                    id="otherJobSkills"
                    label={t("field.otherJobSkills")}
                    help={t("help.otherJobSkills")}
                    value={form.otherJobSkills}
                    onChange={set("otherJobSkills")}
                    error={errors.otherJobSkills}
                    maxLength={MAX_LENGTH.skills}
                    rows={4}
                />
            </FormSection>

            <div className="actions">
                {unsaved && outcome !== "checked" && <p className="unsaved" role="status">{t("details.unsaved")}</p>}
                {outcome === "invalid" && <p className="form-error" role="alert"><span aria-hidden="true">! </span>{t("details.fixErrors")}</p>}
                {outcome === "checked" && <p className="notice" role="status">{t("details.checkPassed")}</p>}
                <button type="submit" className="primary">{t("details.save")}</button>
                <button type="button" className="secondary" onClick={onFinish}>{t("details.finish")}</button>
            </div>
        </form>
    );
}

function hasChanges(form: DetailsForm, initial: DetailsForm): boolean {
    return DETAIL_FIELDS.some((field) => form[field] !== initial[field]);
}
