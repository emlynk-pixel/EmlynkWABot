import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { DEFAULT_FORM_BRANDING } from "../api/formBranding";
import { actionLabel } from "../pages/AuditLogsPage";
import { ADMIN, renderApp, signedInBackend } from "./helpers";

// Settings > Candidate Form: the public form's title, logo and colours. The
// server's own checks are in test/candidateFormBranding.test.js.

const PATH = "/api/admin/settings/form-branding";
const SAVED = { ...DEFAULT_FORM_BRANDING, logo: null, showLogo: true, custom: false, updatedAt: null };
const open = async () => {
    renderApp("/settings/candidate-form");
    return screen.findByRole("textbox", { name: /Form title/ });
};
const puts = (backend: ReturnType<typeof signedInBackend>) => backend.calls.filter((call) => call.method === "PUT" && call.path === PATH);

describe("Settings > Candidate Form", () => {
    test("an ADMIN sees the tab and today's values", async () => {
        signedInBackend({ [`GET ${PATH}`]: { status: 200, body: SAVED } });
        const title = await open();
        expect(title).toHaveValue("Candidate Form");
        expect(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("link", { name: "Candidate Form" })).toBeInTheDocument();
        expect(document.getElementById("dark-background")).toHaveValue(DEFAULT_FORM_BRANDING.colors.dark.background);
    });

    test("the preview follows the edits before anything is saved", async () => {
        const backend = signedInBackend({ [`GET ${PATH}`]: { status: 200, body: SAVED } });
        const user = userEvent.setup();
        const title = await open();
        await user.clear(title);
        await user.type(title, "Recruitment Form");
        expect(within(screen.getByTestId("preview-light")).getByText("Recruitment Form")).toBeInTheDocument();
        expect(within(screen.getByTestId("preview-dark")).getByText("Recruitment Form")).toBeInTheDocument();
        expect(puts(backend)).toHaveLength(0);
    });

    test("saving sends the title and colours, and confirms", async () => {
        const backend = signedInBackend({
            [`GET ${PATH}`]: { status: 200, body: SAVED },
            [`PUT ${PATH}`]: { status: 200, body: { ...SAVED, formTitle: "Recruitment Form", custom: true } },
        });
        const user = userEvent.setup();
        const title = await open();
        await user.clear(title);
        await user.type(title, "Recruitment Form");
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
        const body = puts(backend)[0].body as { formTitle: string; colors: unknown };
        expect(body.formTitle).toBe("Recruitment Form");
        expect(body.colors).toEqual(DEFAULT_FORM_BRANDING.colors);
    });

    test("a colour the server refuses is shown on its own field", async () => {
        signedInBackend({
            [`GET ${PATH}`]: { status: 200, body: SAVED },
            [`PUT ${PATH}`]: { status: 400, body: { message: "Please check the highlighted fields.", errors: [{ field: "colors.light.surface", message: "Light theme: text would be hard to read on this surface colour. Choose a lighter one." }] } },
        });
        const user = userEvent.setup();
        await open();
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        expect(await screen.findByText(/text would be hard to read on this surface colour/)).toBeInTheDocument();
        expect(document.getElementById("light-surface")).toHaveAttribute("aria-invalid", "true");
    });

    test("a logo of the wrong type or size is refused before anything is sent", async () => {
        const backend = signedInBackend({ [`GET ${PATH}`]: { status: 200, body: SAVED } });
        const user = userEvent.setup({ applyAccept: false });
        await open();
        const input = document.getElementById("form-logo") as HTMLInputElement;
        await user.upload(input, new File(["%PDF"], "logo.pdf", { type: "application/pdf" }));
        expect(await screen.findByText("Upload a PNG, JPG, WebP or SVG image.")).toBeInTheDocument();
        await user.upload(input, new File([new Uint8Array(257 * 1024)], "big.png", { type: "image/png" }));
        expect(await screen.findByText("The logo must be 256 KB or smaller.")).toBeInTheDocument();
        expect(puts(backend)).toHaveLength(0);
    });

    test("a logo shows in both previews, and Use EMLYNK logo takes the upload out", async () => {
        signedInBackend({ [`GET ${PATH}`]: { status: 200, body: { ...SAVED, logo: "data:image/png;base64,AAAA", custom: true } } });
        const user = userEvent.setup();
        await open();
        const logoIn = (theme: string) => screen.getByTestId(`preview-${theme}`).querySelector("img");
        expect(logoIn("light")).toHaveAttribute("src", "data:image/png;base64,AAAA");
        await user.click(screen.getByRole("button", { name: "Use EMLYNK logo" }));
        expect(logoIn("dark")).not.toHaveAttribute("src", "data:image/png;base64,AAAA");
        expect(logoIn("dark")).not.toBeNull();
    });

    test("Show a logo is ticked by default; unticking it removes the logo from both previews and saves showLogo false", async () => {
        const backend = signedInBackend({
            [`GET ${PATH}`]: { status: 200, body: { ...SAVED, logo: "data:image/png;base64,AAAA", custom: true } },
            [`PUT ${PATH}`]: { status: 200, body: { ...SAVED, logo: "data:image/png;base64,AAAA", showLogo: false, custom: true } },
        });
        const user = userEvent.setup();
        await open();
        const show = screen.getByRole("checkbox", { name: "Show a logo on the form" });
        expect(show).toBeChecked();
        for (const theme of ["light", "dark"]) expect(screen.getByTestId(`preview-${theme}`).querySelector("img")).not.toBeNull();

        await user.click(show);
        for (const theme of ["light", "dark"]) {
            const preview = screen.getByTestId(`preview-${theme}`);
            expect(preview.querySelector("img")).toBeNull();
            expect(within(preview).getByText("Candidate Form")).toBeInTheDocument();
        }
        expect(document.getElementById("form-logo")).toBeNull();
        expect(screen.getByText(/Your uploaded logo is kept/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Save changes" }));
        expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
        expect(puts(backend)[0].body).toMatchObject({ showLogo: false, logo: "data:image/png;base64,AAAA" });
        expect(screen.getByRole("checkbox", { name: "Show a logo on the form" })).not.toBeChecked();
    });

    test("a saved hidden logo opens unticked, and ticking it again brings the logo back", async () => {
        signedInBackend({ [`GET ${PATH}`]: { status: 200, body: { ...SAVED, showLogo: false, custom: true } } });
        const user = userEvent.setup();
        await open();
        const show = screen.getByRole("checkbox", { name: "Show a logo on the form" });
        expect(show).not.toBeChecked();
        expect(screen.getByTestId("preview-light").querySelector("img")).toBeNull();
        await user.click(show);
        expect(document.getElementById("form-logo")).not.toBeNull();
        expect(screen.getByTestId("preview-light").querySelector("img")).not.toBeNull();
    });

    test("reset asks first, then restores the defaults, removes the upload and shows the logo again", async () => {
        const backend = signedInBackend({
            [`GET ${PATH}`]: { status: 200, body: { ...SAVED, formTitle: "Custom", logo: "data:image/png;base64,AAAA", showLogo: false, custom: true } },
            [`PUT ${PATH}`]: { status: 200, body: SAVED },
        });
        const user = userEvent.setup();
        await open();
        await user.click(screen.getByRole("button", { name: "Reset to EMLYNK defaults" }));
        expect(puts(backend)).toHaveLength(0);
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Reset" }));
        await waitFor(() => expect(puts(backend)).toHaveLength(1));
        expect(puts(backend)[0].body).toMatchObject({ formTitle: "Candidate Form", logo: null, showLogo: true });
    });

    test("a MANAGER gets Access Restricted, and nothing is requested", async () => {
        const backend = signedInBackend({ "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role: "MANAGER" } } } });
        renderApp("/settings/candidate-form");
        expect(await screen.findByText("Access Restricted")).toBeInTheDocument();
        expect(backend.calls.some((call) => call.path === PATH)).toBe(false);
    });

    test("the audit log names the change", () => {
        expect(actionLabel("UPDATE_FORM_BRANDING")).toBe("Candidate form branding changed");
    });
});
