// Height and weight as the Candidate Form takes them (candidateFormDataService.js). The form
// keeps the same rules (candidate-form/src/form/measurements.ts).
//
// Height: centimetres, metres or feet and inches. A number without a unit is centimetres.
//   "175", "175 cm", "175.5cm"       -> "175 cm" / "175.5 cm"
//   "1.75 m", "1,75m"                -> "1.75 m"
//   "5'9\"", "5' 9", "5 ft 9 in", "5ft" -> "5'9\"" / "5'0\""
// The candidate's own unit is kept (as tidy text) for display, and the height is also stored
// in centimetres (one decimal) so every height can be compared. 50 to 250 cm.
//
// Weight: kilograms or grams. A number without a unit is kilograms. Stored as kilograms (up
// to two decimals): "70" -> 70, "70.5 kg" -> 70.5, "70000 g" -> 70. 20 to 300 kg.

export const HEIGHT_CM = Object.freeze({ min: 50, max: 250 });
export const WEIGHT_KG = Object.freeze({ min: 20, max: 300 });
export const MAX_MEASUREMENT_LENGTH = 20;

const NUMBER = String.raw`(\d{1,6}(?:[.,]\d{1,3})?)`;
const METRIC_HEIGHT = new RegExp(String.raw`^${NUMBER}\s*(cm|m)?$`, "i");
const IMPERIAL_HEIGHT = new RegExp(String.raw`^(\d{1,2})\s*(?:'|’|′|ft|feet|foot)\s*(?:${NUMBER}\s*(?:"|”|″|''|’’|in|inch|inches)?)?$`, "i");
const WEIGHT = new RegExp(String.raw`^${NUMBER}\s*(kg|kgs|g)?$`, "i");

const toNumber = (text) => Number(text.replace(",", "."));
// Rounded, without trailing zeros: 175.0 -> "175", 1.750 -> "1.75".
const tidy = (value, decimals) => String(Number(value.toFixed(decimals)));

const squash = (value) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");

// { text, cm } or null when the value is not a height in a known form or not a human height.
export function parseHeight(value) {
    const input = squash(value);
    if (!input || input.length > MAX_MEASUREMENT_LENGTH) return null;
    let text;
    let cm;
    const metric = METRIC_HEIGHT.exec(input);
    if (metric) {
        const amount = toNumber(metric[1]);
        const unit = (metric[2] ?? "cm").toLowerCase();
        cm = unit === "m" ? amount * 100 : amount;
        text = `${tidy(amount, 3)} ${unit}`;
    } else {
        const imperial = IMPERIAL_HEIGHT.exec(input);
        if (!imperial) return null;
        const feet = Number(imperial[1]);
        const inches = imperial[2] === undefined ? 0 : toNumber(imperial[2]);
        if (inches >= 12) return null;
        cm = (feet * 12 + inches) * 2.54;
        text = `${feet}'${tidy(inches, 2)}"`;
    }
    if (!Number.isFinite(cm) || cm < HEIGHT_CM.min || cm > HEIGHT_CM.max) return null;
    return { text, cm: Number(cm.toFixed(1)) };
}

// Kilograms (a number, up to two decimals) or null.
export function parseWeight(value) {
    const input = squash(value);
    if (!input || input.length > MAX_MEASUREMENT_LENGTH) return null;
    const match = WEIGHT.exec(input);
    if (!match) return null;
    const amount = toNumber(match[1]);
    const kg = (match[2] ?? "kg").toLowerCase() === "g" ? amount / 1000 : amount;
    if (!Number.isFinite(kg) || kg < WEIGHT_KG.min || kg > WEIGHT_KG.max) return null;
    return Number(kg.toFixed(2));
}

// "70 kg", "70.5 kg".
export const formatWeightKg = (kg) => `${tidy(Number(kg), 2)} kg`;
