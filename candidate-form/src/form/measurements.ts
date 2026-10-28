// Height and weight as the form takes them. The server keeps the same rules and stays the
// authority (src/utils/bodyMeasurements.js).
//
// Height: centimetres, metres or feet and inches; a number without a unit is centimetres.
//   "175" / "175 cm" -> 175 cm, "1.75 m" -> 175 cm, "5'9\"" / "5 ft 9 in" -> 175.3 cm. 50 to 250 cm.
// Weight: kilograms or grams; a number without a unit is kilograms. "70000 g" -> 70 kg. 20 to 300 kg.

export const HEIGHT_CM = { min: 50, max: 250 } as const;
export const WEIGHT_KG = { min: 20, max: 300 } as const;
export const MAX_MEASUREMENT_LENGTH = 20;

const NUMBER = String.raw`(\d{1,6}(?:[.,]\d{1,3})?)`;
const METRIC_HEIGHT = new RegExp(String.raw`^${NUMBER}\s*(cm|m)?$`, "i");
const IMPERIAL_HEIGHT = new RegExp(String.raw`^(\d{1,2})\s*(?:'|’|′|ft|feet|foot)\s*(?:${NUMBER}\s*(?:"|”|″|''|’’|in|inch|inches)?)?$`, "i");
const WEIGHT = new RegExp(String.raw`^${NUMBER}\s*(kg|kgs|g)?$`, "i");
// A number on its own: the unit is assumed (cm for a height, kg for a weight).
const BARE_NUMBER = /^\s*\d+(?:[.,]\d+)?\s*$/;

const toNumber = (text: string) => Number(text.replace(",", "."));
const tidy = (value: number, decimals: number) => String(Number(value.toFixed(decimals)));
const squash = (value: string) => value.trim().replace(/\s+/g, " ");

export type Height = { text: string; cm: number; unit: "cm" | "m" | "ft" };

export function parseHeight(value: string): Height | null {
    const input = squash(value);
    if (!input || input.length > MAX_MEASUREMENT_LENGTH) return null;
    let result: Height;
    const metric = METRIC_HEIGHT.exec(input);
    if (metric) {
        const amount = toNumber(metric[1]);
        const unit = (metric[2] ?? "cm").toLowerCase() as "cm" | "m";
        result = { text: `${tidy(amount, 3)} ${unit}`, cm: unit === "m" ? amount * 100 : amount, unit };
    } else {
        const imperial = IMPERIAL_HEIGHT.exec(input);
        if (!imperial) return null;
        const feet = Number(imperial[1]);
        const inches = imperial[2] === undefined ? 0 : toNumber(imperial[2]);
        if (inches >= 12) return null;
        result = { text: `${feet}'${tidy(inches, 2)}"`, cm: (feet * 12 + inches) * 2.54, unit: "ft" };
    }
    if (!Number.isFinite(result.cm) || result.cm < HEIGHT_CM.min || result.cm > HEIGHT_CM.max) return null;
    return { ...result, cm: Number(result.cm.toFixed(1)) };
}

export function parseWeight(value: string): number | null {
    const input = squash(value);
    if (!input || input.length > MAX_MEASUREMENT_LENGTH) return null;
    const match = WEIGHT.exec(input);
    if (!match) return null;
    const amount = toNumber(match[1]);
    const kg = (match[2] ?? "kg").toLowerCase() === "g" ? amount / 1000 : amount;
    if (!Number.isFinite(kg) || kg < WEIGHT_KG.min || kg > WEIGHT_KG.max) return null;
    return Number(kg.toFixed(2));
}

export const isBareNumber = (value: string) => BARE_NUMBER.test(value);
// A weight typed in grams ("70000 g"): shown converted to kg under the box.
export const isGrams = (value: string) => /\d\s*g\s*$/i.test(value);
// "70 kg", "70.5 kg".
export const formatKg = (kg: number) => `${tidy(kg, 2)} kg`;
export const formatCm = (cm: number) => `${tidy(cm, 1)} cm`;
