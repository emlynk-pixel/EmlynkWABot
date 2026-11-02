import { useEffect, useState, type CSSProperties, type ChangeEvent, type FormEvent } from "react";
import defaultLogoOnDark from "../assets/emlynk-on-dark.svg";
import defaultLogoOnLight from "../assets/emlynk-on-light.svg";
import { ApiError, type FieldError } from "../api/client";
import { DEFAULT_FORM_BRANDING, getFormBranding, MAX_LOGO_BYTES, saveFormBranding, type BrandingColors, type BrandingTheme, type FormBranding } from "../api/formBranding";
import { useAdminResource } from "../api/useAdminResource";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmDialog, primaryButton, secondaryButton } from "../components/Dialog";
import { FormField, fieldA11y } from "../components/Form";
import { Card, ErrorState, LoadingState, SectionHeading } from "../components/States";
import { inputClass } from "../components/ui";

const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
const COLOR_FIELDS: { key: keyof BrandingColors; label: string; help: string }[] = [
    { key: "accent", label: "Accent", help: "Buttons, progress and selected choices." },
    { key: "background", label: "Background", help: "Behind the form." },
    { key: "surface", label: "Surface", help: "The form's cards and fields." },
];
const THEMES: { theme: BrandingTheme; label: string }[] = [{ theme: "light", label: "Light theme" }, { theme: "dark", label: "Dark theme" }];

type Draft = { formTitle: string; colors: FormBranding["colors"]; logo: string | null; showLogo: boolean };
type Notice = { tone: "ok" | "error"; text: string };

const readDataUri = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
});

// A small picture of the form's header and first card, in the colours being edited.
function Preview({ draft, theme, label }: { draft: Draft; theme: BrandingTheme; label: string }) {
    const { accent, background, surface } = draft.colors[theme];
    const ink = theme === "light" ? "var(--preview-ink-light)" : "var(--preview-ink-dark)";
    const page: CSSProperties = { backgroundColor: background, color: ink };
    return (
        <figure className="m-0">
            <figcaption className="mb-1.5 text-label-sm text-ink-muted">{label}</figcaption>
            <div data-testid={`preview-${theme}`} className="overflow-hidden rounded-xl border border-border" style={page}>
                <div className="flex items-center gap-2 border-b border-current/10 px-3 py-2.5" style={{ backgroundColor: surface }}>
                    {draft.showLogo && <img src={draft.logo ?? (theme === "light" ? defaultLogoOnLight : defaultLogoOnDark)} alt="" className="h-6 w-auto max-w-[96px] object-contain" />}
                    <span className="truncate font-heading text-body-sm font-semibold">{draft.formTitle || "Form title"}</span>
                </div>
                <div className="p-3">
                    <div className="rounded-xl border border-current/10 p-3" style={{ backgroundColor: surface }}>
                        <p className="font-heading text-label-md font-semibold">Personal details</p>
                        <div className="mt-2 h-8 rounded-lg border border-current/20" />
                        <div className="mt-3 flex h-9 items-center justify-center rounded-lg text-label-md text-on-brand" style={{ backgroundColor: accent }}>Continue</div>
                    </div>
                </div>
            </div>
        </figure>
    );
}

// Settings > Candidate Form (ADMIN only; the server checks it too): the public
// form's title, logo and colours. Saved colours must keep the form's text
// readable; the server refuses any that don't and says which field.
export function FormBrandingSettings() {
    const { token } = useAuth();
    const resource = useAdminResource("settings-form-branding", (t, signal) => getFormBranding(t, signal));
    const [draft, setDraft] = useState<Draft | null>(null);
    const [busy, setBusy] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);

    useEffect(() => {
        if (resource.data) setDraft({ formTitle: resource.data.formTitle, colors: resource.data.colors, logo: resource.data.logo, showLogo: resource.data.showLogo });
    }, [resource.data]);

    if (resource.status === "error" && !draft) return <Card className="p-6"><ErrorState message={resource.error.message} onRetry={resource.reload} /></Card>;
    if (!draft) return <Card className="p-6"><LoadingState label="Loading form settings…" /></Card>;

    const errorFor = (field: string) => fieldErrors.find((error) => error.field === field)?.message ?? null;
    const setColor = (theme: BrandingTheme, key: keyof BrandingColors, value: string) =>
        setDraft({ ...draft, colors: { ...draft.colors, [theme]: { ...draft.colors[theme], [key]: value } } });

    const chooseLogo = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setNotice(null);
        if (!LOGO_TYPES.includes(file.type)) return setFieldErrors([{ field: "logo", message: "Upload a PNG, JPG, WebP or SVG image." }]);
        if (file.size > MAX_LOGO_BYTES) return setFieldErrors([{ field: "logo", message: `The logo must be ${MAX_LOGO_BYTES / 1024} KB or smaller.` }]);
        setFieldErrors([]);
        setDraft({ ...draft, logo: await readDataUri(file) });
    };

    const save = async (next: Draft, done: string) => {
        if (!token) return;
        setBusy(true);
        setNotice(null);
        setFieldErrors([]);
        try {
            const saved = await saveFormBranding(token, next);
            setDraft({ formTitle: saved.formTitle, colors: saved.colors, logo: saved.logo, showLogo: saved.showLogo });
            setNotice({ tone: "ok", text: done });
        } catch (caught) {
            if (caught instanceof ApiError) setFieldErrors(caught.fieldErrors);
            setNotice({ tone: "error", text: caught instanceof ApiError ? caught.message : "Something went wrong. Please try again." });
        } finally {
            setBusy(false);
        }
    };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        void save(draft, "Saved. Candidates see the changes the next time the form loads.");
    };

    return (
        <Card className="p-6">
            <SectionHeading title="Candidate Form" description="The title, logo and colours candidates see on the public form. Sinhala text and the form's content don't change." />
            <form onSubmit={submit} noValidate className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
                <div className="space-y-6">
                    <FormField id="form-title" label="Form title" required error={errorFor("formTitle")}>
                        <input
                            {...fieldA11y("form-title", errorFor("formTitle"))}
                            value={draft.formTitle}
                            maxLength={80}
                            disabled={busy}
                            onChange={(event) => setDraft({ ...draft, formTitle: event.target.value })}
                            className={inputClass(Boolean(errorFor("formTitle")))}
                        />
                    </FormField>

                    <FormField id="form-logo" label="Logo" error={errorFor("logo")}>
                        <label className="flex w-fit items-center gap-2 text-body-sm text-ink">
                            <input type="checkbox" checked={draft.showLogo} disabled={busy} onChange={(event) => setDraft({ ...draft, showLogo: event.target.checked })} className="size-4 accent-primary" />
                            Show a logo on the form
                        </label>
                        {draft.showLogo ? (
                            <>
                                <div className="flex flex-wrap items-center gap-2">
                                    <input {...fieldA11y("form-logo", errorFor("logo"))} type="file" accept={LOGO_TYPES.join(",")} disabled={busy} onChange={(event) => void chooseLogo(event)} className="max-w-full text-body-sm text-ink-muted file:mr-2 file:h-8 file:rounded-lg file:border file:border-border-strong file:bg-surface file:px-2.5 file:text-label-md file:text-ink-soft" />
                                    {draft.logo && <button type="button" disabled={busy} onClick={() => setDraft({ ...draft, logo: null })} className={secondaryButton}>Use EMLYNK logo</button>}
                                </div>
                                <p className="text-label-sm text-ink-muted">PNG, JPG, WebP or SVG, up to {MAX_LOGO_BYTES / 1024} KB. The same logo shows in both themes, so check it in both previews. With none uploaded, the form shows the EMLYNK logo.</p>
                            </>
                        ) : (
                            <p className="text-label-sm text-ink-muted">The form shows its title only. {draft.logo ? "Your uploaded logo is kept, and returns if you show the logo again." : "Tick the box to show the EMLYNK logo or upload your own."}</p>
                        )}
                    </FormField>

                    {THEMES.map(({ theme, label }) => (
                        <fieldset key={theme} className="min-w-0">
                            <legend className="text-label-md text-ink">{label} colours</legend>
                            <div className="mt-2 grid gap-4 sm:grid-cols-3">
                                {COLOR_FIELDS.map(({ key, label: colorLabel, help }) => {
                                    const id = `${theme}-${key}`;
                                    const error = errorFor(`colors.${theme}.${key}`);
                                    return (
                                        <FormField key={key} id={id} label={colorLabel} help={help} error={error}>
                                            <div className="flex items-center gap-2">
                                                <input type="color" aria-label={`${label}: ${colorLabel} picker`} value={draft.colors[theme][key]} disabled={busy} onChange={(event) => setColor(theme, key, event.target.value)} className="h-8 w-9 shrink-0 cursor-pointer rounded-lg border border-border-strong bg-surface p-0.5" />
                                                <input {...fieldA11y(id, error)} value={draft.colors[theme][key]} maxLength={7} disabled={busy} onChange={(event) => setColor(theme, key, event.target.value)} className={inputClass(Boolean(error), { extra: "tabular-nums" })} />
                                            </div>
                                        </FormField>
                                    );
                                })}
                            </div>
                        </fieldset>
                    ))}

                    {notice && <p role={notice.tone === "error" ? "alert" : "status"} className={`text-body-sm ${notice.tone === "error" ? "text-critical" : "text-ink-muted"}`}>{notice.text}</p>}

                    <div className="flex flex-wrap gap-2">
                        <button type="submit" disabled={busy} className={primaryButton}>{busy ? "Saving…" : "Save changes"}</button>
                        <button type="button" disabled={busy} onClick={() => setResetting(true)} className={secondaryButton}>Reset to EMLYNK defaults</button>
                    </div>
                </div>

                <div className="space-y-4">
                    {THEMES.map(({ theme, label }) => <Preview key={theme} draft={draft} theme={theme} label={label} />)}
                </div>
            </form>

            {resetting && (
                <ConfirmDialog
                    title="Reset the candidate form?"
                    description="This removes the custom logo, shows the EMLYNK logo, and sets the title and colours back to the EMLYNK defaults."
                    confirmLabel="Reset"
                    variant="warning"
                    busy={busy}
                    onCancel={() => setResetting(false)}
                    onConfirm={async () => {
                        await save({ ...DEFAULT_FORM_BRANDING, logo: null, showLogo: true }, "Reset to the EMLYNK defaults.");
                        setResetting(false);
                    }}
                />
            )}
        </Card>
    );
}
