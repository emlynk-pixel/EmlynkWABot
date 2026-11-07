// Settings > Candidate Form: the title, logo and colours of the public form.
// One row, read by the form on load (POST /api/public/candidate-details/branding)
// and edited by an ADMIN (GET and PUT /api/admin/settings/form-branding).
//
//   - No row means the EMLYNK defaults, so the form works before anything is saved.
//   - Colours that would leave text unreadable are refused here, not just in the
//     browser: a candidate must always be able to read the form.
//   - The logo is a small image kept as a data: URI (migration
//     20261105120000_candidate_form_branding). Its bytes are checked against its
//     declared type. The form only ever shows it in an <img>, where an SVG's
//     scripts cannot run; the SVG checks below are a second line of defence.
//   - The audit entry records the title and colours, and only whether the logo
//     changed, never its bytes.

import { auditRow } from "./agentService.js";

const SINGLETON_ID = "default";

export const FORM_BRANDING_AUDIT_ACTION = "UPDATE_FORM_BRANDING";
export const MAX_FORM_TITLE_LENGTH = 80;
export const MAX_LOGO_BYTES = 256 * 1024;

export const DEFAULT_FORM_BRANDING = Object.freeze({
    formTitle: "Candidate Form",
    colors: Object.freeze({
        light: Object.freeze({ accent: "#e7000b", background: "#f0f0f0", surface: "#ffffff" }),
        dark: Object.freeze({ accent: "#e7000b", background: "#1f242b", surface: "#262c34" }),
    }),
});

// The form's own text colours (candidate-form/src/styles.css), which custom
// backgrounds have to work with. The muted one is the harder test.
const THEME_TEXT = Object.freeze({ light: { ink: "#0a0a0a", muted: "#525252" }, dark: { ink: "#e5e7eb", muted: "#9ca3af" } });
const MIN_TEXT_CONTRAST = 4.5;
// The accent is a fill behind a label the form keeps readable, and accent-coloured
// text is lightened by the form itself, so the fill only has to stand out.
const MIN_FILL_CONTRAST = 2.5;

const HEX_COLOR = /^#[0-9a-f]{6}$/;
const LOGO_DATA_URI = /^data:image\/(png|jpeg|webp|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/;
const SVG_ACTIVE_CONTENT = /<script|<foreignobject|<iframe|<embed|<object|\bon[a-z]+\s*=|javascript:|href\s*=\s*["']?(?!#)/i;
// Control characters, including line breaks: the title is one line of plain text.
const CONTROL_CHARACTERS = /\p{Cc}/u;

const startsWith = (buffer, bytes, offset = 0) => bytes.every((byte, index) => buffer[index + offset] === byte);
const LOGO_SIGNATURES = {
    png: (buffer) => startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    jpeg: (buffer) => startsWith(buffer, [0xff, 0xd8, 0xff]),
    webp: (buffer) => startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8),
    "svg+xml": (buffer) => {
        const text = buffer.toString("utf8");
        return /<svg[\s>]/i.test(text) && !SVG_ACTIVE_CONTENT.test(text);
    },
};

function luminance(hex) {
    const [r, g, b] = [1, 3, 5]
        .map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
        .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(first, second) {
    const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
}

function colorErrors(theme, colors) {
    const name = theme === "light" ? "Light" : "Dark";
    const errors = [];
    for (const key of ["accent", "background", "surface"]) {
        if (typeof colors?.[key] !== "string" || !HEX_COLOR.test(colors[key].toLowerCase())) {
            errors.push({ field: `colors.${theme}.${key}`, message: "Enter a colour like #e7000b." });
        }
    }
    if (errors.length) return errors;

    const { ink, muted } = THEME_TEXT[theme];
    for (const key of ["background", "surface"]) {
        if (Math.min(contrastRatio(ink, colors[key]), contrastRatio(muted, colors[key])) < MIN_TEXT_CONTRAST) {
            errors.push({ field: `colors.${theme}.${key}`, message: `${name} theme: text would be hard to read on this ${key} colour. Choose a ${theme === "light" ? "lighter" : "darker"} one.` });
        }
    }
    if (contrastRatio(colors.accent, colors.surface) < MIN_FILL_CONTRAST) {
        errors.push({ field: `colors.${theme}.accent`, message: `${name} theme: this accent colour doesn't stand out from the surface colour.` });
    }
    return errors;
}

function logoError(logo) {
    const match = LOGO_DATA_URI.exec(logo);
    if (!match) return "Upload a PNG, JPG, WebP or SVG image.";
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > MAX_LOGO_BYTES) return `The logo must be ${MAX_LOGO_BYTES / 1024} KB or smaller.`;
    return LOGO_SIGNATURES[match[1]](bytes) ? null : "This file can't be used as a logo. Upload a different image.";
}

// PUT body: { values } or { errors }. `logo`: a data: URI, null to remove it (the
// form then shows the EMLYNK logo), or left out to keep the current one.
// `showLogo`: false hides the logo on the form altogether; left out keeps it as is.
export function parseBrandingBody(body) {
    const errors = [];
    const unknown = Object.keys(body ?? {}).filter((key) => !["formTitle", "colors", "logo", "showLogo"].includes(key));
    if (unknown.length) errors.push({ field: unknown[0], message: "This field is not accepted." });

    const formTitle = typeof body?.formTitle === "string" ? body.formTitle.trim() : "";
    if (!formTitle) errors.push({ field: "formTitle", message: "Enter a form title." });
    else if (formTitle.length > MAX_FORM_TITLE_LENGTH) errors.push({ field: "formTitle", message: `The title must be ${MAX_FORM_TITLE_LENGTH} characters or fewer.` });
    else if (CONTROL_CHARACTERS.test(formTitle)) errors.push({ field: "formTitle", message: "The title must be one line of plain text." });

    errors.push(...colorErrors("light", body?.colors?.light), ...colorErrors("dark", body?.colors?.dark));

    const logo = body?.logo;
    if (logo !== undefined && logo !== null) {
        const problem = typeof logo === "string" ? logoError(logo) : "Upload a PNG, JPG, WebP or SVG image.";
        if (problem) errors.push({ field: "logo", message: problem });
    }

    const showLogo = body?.showLogo;
    if (showLogo !== undefined && typeof showLogo !== "boolean") errors.push({ field: "showLogo", message: "Choose whether to show the logo." });

    if (errors.length) return { errors };
    const pick = ({ accent, background, surface }) => ({ accent: accent.toLowerCase(), background: background.toLowerCase(), surface: surface.toLowerCase() });
    return {
        values: {
            formTitle,
            colors: { light: pick(body.colors.light), dark: pick(body.colors.dark) },
            ...(logo === undefined ? {} : { logo }),
            ...(showLogo === undefined ? {} : { showLogo }),
        },
    };
}

// The choice to hide the logo is stored beside the two themes in the colors column,
// and never reaches anyone as a colour. A row saved without it shows the logo.
const splitColors = ({ showLogo = true, ...colors }) => ({ colors, showLogo });

const view = (row) =>
    row
        ? { formTitle: row.formTitle, ...splitColors(row.colors), logo: row.logoDataUri ?? null, custom: true, updatedAt: row.updatedAt.toISOString() }
        : { ...DEFAULT_FORM_BRANDING, logo: null, showLogo: true, custom: false, updatedAt: null };

export async function getFormBranding({ db }) {
    return view(await db.candidateFormBranding.findUnique({ where: { id: SINGLETON_ID } }));
}

// What the public form receives: nothing about who changed it, or when.
export async function getPublicFormBranding({ db }) {
    const { formTitle, colors, logo, showLogo, custom } = await getFormBranding({ db });
    return { formTitle, colors, logo, showLogo, custom };
}

export function publicDefaultBranding() {
    return { ...DEFAULT_FORM_BRANDING, logo: null, showLogo: true, custom: false };
}

export async function updateFormBranding({ db, actor, values }) {
    return db.$transaction(async (tx) => {
        const before = await tx.candidateFormBranding.findUnique({ where: { id: SINGLETON_ID } });
        const logoDataUri = values.logo === undefined ? before?.logoDataUri ?? null : values.logo;
        const previous = before ? splitColors(before.colors) : null;
        const showLogo = values.showLogo ?? previous?.showLogo ?? true;
        const data = { formTitle: values.formTitle, colors: { ...values.colors, showLogo }, logoDataUri, updatedAt: new Date() };
        const row = await tx.candidateFormBranding.upsert({ where: { id: SINGLETON_ID }, create: { id: SINGLETON_ID, ...data }, update: data });

        const logoChange = logoDataUri === (before?.logoDataUri ?? null) ? "UNCHANGED" : logoDataUri ? "CHANGED" : "REMOVED";
        await tx.auditLog.create({
            data: auditRow({
                actor,
                action: FORM_BRANDING_AUDIT_ACTION,
                previousStatus: before ? "CUSTOM" : "DEFAULT",
                newStatus: "CUSTOM",
                reason: "Candidate form branding updated",
                previousValue: before ? JSON.stringify({ formTitle: before.formTitle, ...previous }) : null,
                newValue: JSON.stringify({ formTitle: row.formTitle, ...splitColors(row.colors), logo: logoChange }),
            }),
        });
        return view(row);
    });
}
