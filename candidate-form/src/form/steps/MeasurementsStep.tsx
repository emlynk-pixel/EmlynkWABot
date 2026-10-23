import { useState } from "react";
import { SelectInput } from "../../components/inputs";
import { SizeField } from "../../components/SizeField";
import { SizeGuide } from "../../components/SizeGuide";
import { useLanguage } from "../../i18n/useLanguage";
import { bind, type StepProps } from "../binding";
import { SHIRT_SIZES, SHOE_SIZE_GUIDE, SHOE_SIZE_PRESETS, WAIST_SIZE_PRESETS } from "../options";

// Physical Measurements: shirt, hip / waist (inches) and shoe size (UK list,
// or Other for any size such as "EU 43"). All three are required and none
// takes "N/A" (a real size is needed). The size guides are reference only:
// the shoe size is still answered and stored as before (a UK size from the
// list, or what is typed under Other); the EU column never changes it.
export function MeasurementsStep(props: StepProps) {
    const { t } = useLanguage();
    const [other, setOther] = useState({ waist: false, shoe: false });
    const shirt = bind(props, "measurements.shirtSize");
    const waist = bind(props, "measurements.waistSize");
    const shoe = bind(props, "measurements.shoeSize");
    return (
        <div className="field-grid">
            <div>
                <SelectInput {...shirt} label={t("f.shirtSize")} options={SHIRT_SIZES.map((size) => ({ value: size, label: size }))} />
                <SizeGuide id="guide-shirt" title={t("guide.shirt.title")}>
                    <dl className="size-guide-list">
                        {SHIRT_SIZES.map((size) => (
                            <div key={size}>
                                <dt>{size}</dt>
                                <dd>{t(`shirt.${size}`)}</dd>
                            </div>
                        ))}
                    </dl>
                    <p className="size-guide-note">{t("guide.shirt.note")}</p>
                </SizeGuide>
            </div>
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
                required={waist.required}
            />
            <div>
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
                    required={shoe.required}
                />
                <SizeGuide id="guide-shoe" title={t("guide.shoe.title")}>
                    <table className="size-guide-table">
                        <thead>
                            <tr>
                                <th scope="col">{t("guide.shoe.uk")}</th>
                                <th scope="col">{t("guide.shoe.eu")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {SHOE_SIZE_GUIDE.map((row) => (
                                <tr key={row.uk}>
                                    <td>{row.uk}</td>
                                    <td>{row.eu}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="size-guide-note">{t("guide.shoe.note")}</p>
                </SizeGuide>
            </div>
        </div>
    );
}
