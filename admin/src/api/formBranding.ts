import { apiRequest } from "./client";

// Settings > Candidate Form (src/services/candidateFormBrandingService.js). ADMIN only;
// the server enforces it, and refuses colours that would leave the form unreadable.

export type BrandingTheme = "light" | "dark";
export type BrandingColors = { accent: string; background: string; surface: string };

export type FormBranding = {
    formTitle: string;
    colors: Record<BrandingTheme, BrandingColors>;
    logo: string | null;
    // false: the form shows no logo at all (no uploaded logo means the EMLYNK one).
    showLogo: boolean;
    custom: boolean;
    updatedAt: string | null;
};

export type FormBrandingInput = {
    formTitle: string;
    colors: Record<BrandingTheme, BrandingColors>;
    // A data: URI, null to remove the logo, or left out to keep it.
    logo?: string | null;
    // false hides the logo on the form; left out keeps the current choice.
    showLogo?: boolean;
};

// The same limit and defaults as the server's.
export const MAX_LOGO_BYTES = 256 * 1024;
export const DEFAULT_FORM_BRANDING: Pick<FormBranding, "formTitle" | "colors"> = {
    formTitle: "Candidate Form",
    colors: {
        light: { accent: "#e7000b", background: "#f0f0f0", surface: "#ffffff" },
        dark: { accent: "#e7000b", background: "#1f242b", surface: "#262c34" },
    },
};

const PATH = "/api/admin/settings/form-branding";

export const getFormBranding = (token: string, signal?: AbortSignal) => apiRequest<FormBranding>(PATH, { token, signal });
export const saveFormBranding = (token: string, body: FormBrandingInput) => apiRequest<FormBranding>(PATH, { method: "PUT", token, body });
