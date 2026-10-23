import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { App } from "../App";
import { emptyForm, toPayload } from "../form/model";
import { JOB_CATEGORIES } from "../form/options";
import { TRANSLATIONS, type MessageKey } from "../i18n/translations";
import type { CandidateFormPayload, FormLoadResponse } from "../types/api";

// Shared by the candidate-form tests. The backend is a stub: nothing leaves
// the test.

export const en = (key: MessageKey) => TRANSLATIONS.en[key];
export const si = (key: MessageKey) => TRANSLATIONS.si[key];

// A field by the start of its label (a label may end with " * (required)";
// the help button's name, "Help: …", never starts with the label).
export const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

// The share link's secret (set for every test in setup.ts).
export const LINK_SECRET = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
export const TOKEN = "cf1~test-iv~test-ciphertext";
export const PASSPORT = "N1234567";
export const NIC = "901234567V";
export const WHATSAPP = "+94771234567";
export const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

// What POST /form returns: the identity and a partial prefill.
export const IDENTITY = { passportNumber: PASSPORT, nic: NIC, whatsappNumber: WHATSAPP };
export function prefill(overrides: (p: CandidateFormPayload) => void = () => {}): FormLoadResponse {
    const answers = toPayload(emptyForm());
    answers.basic.surname = "PERERA";
    answers.basic.otherNames = "KAMAL";
    answers.basic.sex = "MALE";
    overrides(answers);
    const prefilled = [["basic", answers.basic], ["contact", answers.contact], ["passport", answers.passport]]
        .flatMap(([group, values]) => Object.entries(values as Record<string, string | null>).filter(([, v]) => v !== null).map(([k]) => `${group}.${k}`));
    // The active job types the server sends with the form (here the seeded trades).
    return { identity: IDENTITY, answers, prefilled, jobCategories: JOB_CATEGORIES.filter((code) => code !== "OTHER"), expiresAt: inMinutes(60) };
}

export type Reply = { status: number; body?: unknown } | "network";
export type Routes = { verify?: Reply; form?: Reply; draft?: Reply | ((call: number) => Reply); submit?: Reply | ((call: number) => Reply) };
export type User = ReturnType<typeof userEvent.setup>;
export type Call = { url: string; path: string; init: RequestInit; body: unknown };

const OK_VERIFY: Reply = { status: 200, body: { token: TOKEN, expiresAt: inMinutes(60) } };

// Stubs fetch for the public endpoints (draft: a save of one step, answered 200 unless told otherwise) and records every request.
export function backend(routes: Routes = {}) {
    const calls: Call[] = [];
    let submits = 0;
    let drafts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
        const path = new URL(String(url), "http://localhost").pathname;
        calls.push({ url: String(url), path, init, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
        let reply: Reply = { status: 404, body: { message: "Not found" } };
        if (path.endsWith("/verify")) reply = routes.verify ?? OK_VERIFY;
        if (path.endsWith("/form")) reply = routes.form ?? { status: 200, body: prefill() };
        if (path.endsWith("/draft")) {
            drafts += 1;
            const step = (typeof init.body === "string" ? JSON.parse(init.body) : {}).step;
            const r = routes.draft ?? { status: 200, body: { savedSteps: [step], savedAt: new Date().toISOString() } };
            reply = typeof r === "function" ? r(drafts) : r;
        }
        if (path.endsWith("/submit")) {
            submits += 1;
            const r = routes.submit ?? { status: 200, body: { submittedAt: new Date().toISOString() } };
            reply = typeof r === "function" ? r(submits) : r;
        }
        if (reply === "network") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "Content-Type": "application/json" } });
    }));
    return calls;
}
export const callsTo = (calls: Call[], endpoint: "verify" | "form" | "draft" | "submit") => calls.filter((c) => c.path.endsWith(`/${endpoint}`));

export async function fillVerify(user: User, passport = PASSPORT, nic = NIC) {
    await user.type(screen.getByLabelText(/^(Passport Number|ගමන් බලපත්‍ර අංකය)/), passport);
    await user.type(screen.getByLabelText(/^(NIC Number|ජාතික හැඳුනුම්පත් අංකය)/), nic);
}

// "I Understand – Continue" on the "Before you start" page (both languages in one button).
export const CONTINUE = new RegExp(`^${en("guidelines.continue")}`);
export const continueButton = () => screen.getByRole("button", { name: CONTINUE });

// Renders the app and verifies; resolves on the form's first step (after the
// "Before you start" page and its Continue).
export async function verified(options: Parameters<typeof userEvent.setup>[0] = {}, routes: Routes = {}) {
    const calls = backend(routes);
    render(<App />);
    const user = userEvent.setup(options);
    await fillVerify(user);
    await user.click(screen.getByRole("button", { name: en("verify.submit") }));
    await user.click(await screen.findByRole("button", { name: CONTINUE }));
    await screen.findByRole("heading", { level: 2, name: en("step.personal") });
    return { user, calls };
}

export const switchLanguage = (user: User, name: "English" | "සිංහල") =>
    user.click(within(screen.getByRole("group", { name: "Language / භාෂාව" })).getByRole("button", { name }));

// Sets a field's value in one event (the onChange path runs, uppercase included).
export const setField = (label: MessageKey | string, value: string) =>
    fireEvent.change(screen.getByLabelText(startsWith(label in TRANSLATIONS.en ? en(label as MessageKey) : label)), { target: { value } });

export const field = (key: MessageKey) => screen.getByLabelText(startsWith(en(key)));
export const queryField = (key: MessageKey) => screen.queryByLabelText(startsWith(en(key)));
export const stepHeading = (key: MessageKey) => screen.getByRole("heading", { level: 2, name: startsWith(en(key)) });
// A section inside a step (Basic, Contact, Passport & Qualifications, Measurements, Family, Guardian).
export const sectionHeading = (key: MessageKey) => screen.getByRole("heading", { level: 3, name: startsWith(en(key)) });
// Clicks Next and waits until the step has finished saving (a step that fails its checks never starts to).
export async function next(user: User) {
    await user.click(screen.getByRole("button", { name: en("form.next") }));
    await waitFor(() => expect(screen.queryByRole("button", { name: en("form.saving") })).toBeNull());
}

// Valid answers for EVERY field (all are required), step by step, with "N/A"
// where the form allows it (no other names, no second phone, no skills, no
// father, no children). The prefill already has the surname, other names and sex.
export function fillBasic(civilStatus = "SINGLE") {
    setField("f.fullName", "shamal");
    setField("f.surname", "sathsara");
    setField("f.sex", "MALE");
    setField("f.civilStatus", civilStatus);
    setField("f.birthDate", "1990-05-01");
    setField("f.birthPlace", "colombo");
}
export function fillContact() {
    setField("f.address", "12 main street");
    setField("f.city", "colombo");
    setField("f.district", "colombo");
    setField("f.dsDivision", "kolonnawa");
    setField("f.gnDivision", "kolonnawa north");
    setField("f.alternativePhone", "n/a");
    setField("f.email", "shamal@example.com");
}
export async function fillPassport(user: User, job = "WELDER TIG") {
    setField("f.passportIssueDate", "2020-01-15");
    setField("f.passportExpiryDate", "2030-01-14");
    setField("f.jobCategory", job);
    setField("f.experience", "5 years");
    setField("f.otherSkills1", "N/A");
    setField("f.otherSkills2", "N/A");
    await user.click(screen.getByRole("radio", { name: en("english.GOOD") }));
}
export function fillMeasurements() {
    setField("f.shirtSize", "M");
    setField("f.waistSize", "32");
    setField("f.shoeSize", "9");
}
// Father does not apply ("N/A": his other answers are then not needed); mother in full; no children.
export function fillFamily({ spouse = false }: { spouse?: boolean } = {}) {
    setField("f.fatherName", "N/A");
    setField("f.motherName", "kumari");
    setField("f.motherSurname", "perera");
    setField("f.motherPassport", "N/A");
    setField("f.motherBirthDate", "1965-02-03");
    if (spouse) {
        setField("f.spouseName", "nadeesha");
        setField("f.spouseSurname", "silva");
        setField("f.spousePassport", "N/A");
        setField("f.spouseBirthDate", "1992-07-08");
    }
    setField("f.child1", "N/A");
}
export function fillGuardian() {
    setField("f.guardianName", "kamal perera");
    setField("f.guardianRelationship", "uncle");
    setField("f.guardianNic", "901234567V");
    setField("f.guardianBirthDate", "1960-01-01");
    setField("f.guardianPhone", "0771234567");
    setField("f.guardianAddress", "45 lake road");
}
export async function fillWork(user: User, { spouse = false, job = "WELDER TIG" }: { spouse?: boolean; job?: string } = {}) {
    await fillPassport(user, job);
    fillMeasurements();
    fillFamily({ spouse });
    fillGuardian();
}

// From the first step to the review, filling every required answer.
export async function completeToReview(user: User, { civilStatus = "SINGLE" }: { civilStatus?: string } = {}) {
    fillBasic(civilStatus);
    fillContact();
    await next(user); // Personal Details
    await fillWork(user, { spouse: civilStatus === "MARRIED" });
    await next(user); // Work & Family Details
    await screen.findByRole("heading", { level: 2, name: en("step.review") });
}
