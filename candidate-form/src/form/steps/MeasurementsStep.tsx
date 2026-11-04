import { useState } from "react";
import { SelectInput } from "../../components/inputs";
import { SizeField } from "../../components/SizeField";
import { SizeGuide } from "../../components/SizeGuide";
import { useLanguage } from "../../i18n/useLanguage";
import { bind, type StepProps } from "../binding";
import { SHIRT_SIZES, SHIRT_SIZE_CHART, SHIRT_SIZE_CHART_COLUMNS, SHOE_SIZE_PRESETS, WAIST_SIZE_PRESETS } from "../options";

// Physical Measurements: shirt, hip / waist (inches) and shoe size (EU sizes
// only: the list, or Other for an EU size not in it). All three are required and
// none takes "N/A" (a real size is needed). The size guides are reference only
// and never change the answer.
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
                    <div className="size-chart-scroll">
                        <table className="size-chart">
                            <thead>
                                <tr>
                                    <th scope="col"><span className="visually-hidden">{t("f.shirtSize")}</span></th>
                                    {SHIRT_SIZE_CHART_COLUMNS.map((column) => <th key={column} scope="col">{t(`guide.shirt.${column}`)}</th>)}
                                </tr>
                            </thead>
                            <tbody>
                                {SHIRT_SIZE_CHART.map((row) => (
                                    <tr key={row.size}>
                                        <th scope="row">{row.size}</th>
                                        {row.values.map((value, index) => <td key={SHIRT_SIZE_CHART_COLUMNS[index]}>{value}</td>)}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
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
                    <ul className="size-guide-tips">
                        <li>{t("guide.shoe.tip1")}</li>
                        <li>{t("guide.shoe.tip2")}</li>
                    </ul>
                    <p className="size-guide-note">{t("guide.shoe.note", { from: SHOE_SIZE_PRESETS[0], to: SHOE_SIZE_PRESETS[SHOE_SIZE_PRESETS.length - 1] })}</p>
                </SizeGuide>
            </div>
        </div>
    );
}
