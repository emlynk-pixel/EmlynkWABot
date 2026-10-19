import { useState } from "react";
import { SelectInput } from "../../components/inputs";
import { SizeField } from "../../components/SizeField";
import { useLanguage } from "../../i18n/useLanguage";
import { bind, type StepProps } from "../binding";
import { SHIRT_SIZES, SHOE_SIZE_PRESETS, WAIST_SIZE_PRESETS } from "../options";

// Physical Measurements: shirt, hip / waist (inches) and shoe size (UK list,
// or Other for any size such as "EU 43").
export function MeasurementsStep(props: StepProps) {
    const { t } = useLanguage();
    const [other, setOther] = useState({ waist: false, shoe: false });
    const waist = bind(props, "measurements.waistSize");
    const shoe = bind(props, "measurements.shoeSize");
    return (
        <div className="field-grid">
            <SelectInput {...bind(props, "measurements.shirtSize")} label={t("f.shirtSize")} options={SHIRT_SIZES.map((size) => ({ value: size, label: size }))} />
            <SizeField
                id={waist.id}
                label={t("f.waistSize")}
                otherLabel={t("f.waistSizeOther")}
                help={t("help.waistSize")}
                presets={WAIST_SIZE_PRESETS}
                value={waist.value}
                other={other.waist}
                onChange={waist.onChange}
                onOtherChange={(value) => setOther((previous) => ({ ...previous, waist: value }))}
                error={waist.error}
            />
            <SizeField
                id={shoe.id}
                label={t("f.shoeSize")}
                otherLabel={t("f.shoeSizeOther")}
                help={t("help.shoeSize")}
                presets={SHOE_SIZE_PRESETS}
                value={shoe.value}
                other={other.shoe}
                onChange={shoe.onChange}
                onOtherChange={(value) => setOther((previous) => ({ ...previous, shoe: value }))}
                error={shoe.error}
            />
        </div>
    );
}
