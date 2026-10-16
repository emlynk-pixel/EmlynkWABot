import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "../App";
import { TRANSLATIONS, type MessageKey } from "../i18n/translations";

// Shared by the candidate-form tests. The backend is a stub: nothing leaves
// the test.

export const en = (key: MessageKey) => TRANSLATIONS.en[key];
export const si = (key: MessageKey) => TRANSLATIONS.si[key];

// A field by the start of its label (a label may end with " * (required)";
// the help button's name, "Help: …", never starts with the label).
export const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

export const TOKEN = "cf1~test-iv~test-ciphertext";
export const PASSPORT = "N1234567";
export const WHATSAPP = "+94771234567";
export const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

export type Reply = { status: number; body?: unknown } | "network";
export type User = ReturnType<typeof userEvent.setup>;

// Stubs fetch with one reply and records every request.
export function backend(reply: Reply = { status: 200, body: { token: TOKEN, expiresAt: inMinutes(15) } }) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        if (reply === "network") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "Content-Type": "application/json" } });
    }));
    return calls;
}

export async function fillVerify(user: User, passport = PASSPORT, whatsapp = WHATSAPP) {
    await user.type(screen.getByLabelText(/^(Passport Number|ගමන් බලපත්‍ර අංකය)/), passport);
    await user.type(screen.getByLabelText(/^(WhatsApp Number|WhatsApp අංකය)/), whatsapp);
}

// Renders the app and verifies; resolves on the form's first step.
export async function verified(options: Parameters<typeof userEvent.setup>[0] = {}) {
    const calls = backend();
    render(<App />);
    const user = userEvent.setup(options);
    await fillVerify(user);
    await user.click(screen.getByRole("button", { name: en("verify.submit") }));
    await screen.findByRole("heading", { level: 2, name: en("step.basic") });
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
export const next = (user: User) => user.click(screen.getByRole("button", { name: en("form.next") }));

// Valid answers for every required field, step by step.
export function fillBasic(civilStatus = "SINGLE") {
    setField("f.fullName", "shamal");
    setField("f.surname", "sathsara");
    setField("f.nic", "199012345678");
    setField("f.sex", "MALE");
    setField("f.civilStatus", civilStatus);
    setField("f.birthDate", "1990-05-01");
}
export function fillContact() {
    setField("f.address", "12 main street");
    setField("f.district", "colombo");
    setField("f.dsDivision", "kolonnawa");
    setField("f.email", "shamal@example.com");
}
export async function fillPassport(user: User, job = "WELDER TIG") {
    setField("f.passportIssueDate", "2020-01-15");
    setField("f.passportExpiryDate", "2030-01-14");
    setField("f.jobCategory", job);
    await user.click(screen.getByRole("radio", { name: en("english.GOOD") }));
}
export function fillGuardian() {
    setField("f.guardianName", "kamal perera");
    setField("f.guardianNic", "901234567V");
    setField("f.guardianPhone", "0771234567");
    setField("f.guardianAddress", "45 lake road");
}

// From the first step to the review, filling every required answer.
export async function completeToReview(user: User, { civilStatus = "SINGLE" }: { civilStatus?: string } = {}) {
    fillBasic(civilStatus);
    await next(user);
    fillContact();
    await next(user);
    await fillPassport(user);
    await next(user);
    await next(user); // measurements: nothing required
    await next(user); // family: nothing required
    fillGuardian();
    await next(user);
    await screen.findByRole("heading", { level: 2, name: en("step.review") });
}
