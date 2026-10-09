import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router";
import { describe, expect, test, vi } from "vitest";
import { CANDIDATE_STAGES, type AdditionalDetails, type AdditionalDetailsView, type CandidateDetails } from "../api/candidates";
import { AppRoutes } from "../App";
import { AuthProvider } from "../auth/AuthProvider";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// Candidate > Additional details (opened from its progress step). Synthetic data only; the backend is stubbed.

const DETAILS: CandidateDetails = {
    candidate: {
        passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], surname: "SILVA", otherNames: "SAMAN",
        dateOfBirth: "1990-03-12", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", passportIssueDate: null, nationality: null, sex: null,
        address: "1 Main Street", jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null,
    },
    stages: CANDIDATE_STAGES.map((stage) => ({
        stage, completed: false, completedAt: null, notes: null, jobId: null, testResult: null, testDate: null,
        automatic: stage === "CANDIDATE_DETAILS" || stage === "DOCUMENT_SUBMISSION", missing: [],
    })),
    documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null },
    variantDocuments: { POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null } },
    requiredDocuments: [],
};

const EMPTY: AdditionalDetails = {
    nameAsInPassport: null, permanentAddress: null, birthday: null, tshirtSize: null, pantSize: null, shoeSize: null,
    fatherAlive: null, fatherFullName: null, fatherBirthday: null, motherAlive: null, motherFullName: null, motherBirthday: null,
    maritalStatus: null, wifeFullName: null, wifeBirthday: null, child1Name: null, child2Name: null, child3Name: null, otherJobSkills: null,
};

const SUGGESTED = { nameAsInPassport: "SAMAN SILVA", permanentAddress: "1 Main Street", birthday: "1990-03-12" };
const NEW_VIEW: AdditionalDetailsView = { passportId: "N0000002", details: null, suggested: SUGGESTED, updatedDate: null };
const SAVED: AdditionalDetails = { ...EMPTY, nameAsInPassport: "SAMAN K SILVA", tshirtSize: "L", pantSize: "31", shoeSize: "9", fatherAlive: true, fatherFullName: "Sunil Silva", maritalStatus: "SINGLE" };
const SAVED_VIEW: AdditionalDetailsView = { passportId: "N0000002", details: SAVED, suggested: SUGGESTED, updatedDate: "2026-10-09T05:00:00.000Z" };

const PATH = "/api/admin/candidates/N0000002/additional-details";

function backend(view: AdditionalDetailsView, routes: FetchRoutes = {}, user = ADMIN) {
    return signedInBackend({
        "GET /auth/me": { status: 200, body: { user } },
        "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
        [`GET ${PATH}`]: { status: 200, body: view },
        ...routes,
    });
}

// Opened from its progress step (there is no tab bar).
const openTab = async () => {
    const stepper = await screen.findByRole("navigation", { name: "Deployment stages" }, RENDER_STEP);
    await userEvent.setup().click(within(stepper).getByRole("button", { name: /^3\. Additional details/ }));
    return screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
};
const puts = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method === "PUT" && c.path === PATH);

describe("Additional Details", () => {
    test("no Deployment / Additional Details tab bar; the form opens from its step, with its sections", async () => {
        backend(NEW_VIEW);
        renderApp("/candidates/N0000002");
        expect(await screen.findByRole("heading", { name: "Test details" }, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByRole("tablist")).toBeNull();
        expect(screen.queryByRole("tab")).toBeNull();
        expect(screen.queryByText("Deployment", { selector: "button" })).toBeNull();

        await openTab();
        for (const section of ["Passport & personal details", "Clothing & sizes", "Father details", "Mother details", "Marital & family details", "Employment / skills"]) {
            expect(screen.getByRole("group", { name: section })).toBeInTheDocument();
        }
        expect(screen.queryByRole("tablist")).toBeNull();
    });

    test("a new form is filled in from the candidate's record, with the passport number read-only; nothing is saved until Save", async () => {
        const { calls } = backend(NEW_VIEW, { [`PUT ${PATH}`]: { status: 200, body: { ...SAVED_VIEW, details: { ...EMPTY, ...SUGGESTED } } } });
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        expect(screen.getByLabelText("Passport number")).toHaveValue("N0000002");
        expect(screen.getByLabelText("Passport number")).toHaveAttribute("readonly");
        expect(screen.getByLabelText("Name according to passport")).toHaveValue("SAMAN SILVA");
        expect(screen.getByLabelText("Permanent address")).toHaveValue("1 Main Street");
        expect(screen.getByLabelText("Birthday")).toHaveValue("1990-03-12");
        expect(screen.getByRole("note")).toHaveTextContent("Filled in from the candidate's record: name according to passport, permanent address, birthday");
        expect(puts(calls)).toHaveLength(0);

        await userEvent.setup().click(screen.getByRole("button", { name: "Save additional details" }));
        await vi.waitFor(() => expect(puts(calls)).toHaveLength(1));
        expect(puts(calls)[0].body).toEqual({ ...EMPTY, ...SUGGESTED, expectedUpdatedDate: null });
        expect(await screen.findByText("Additional details saved.")).toBeInTheDocument();
        expect(calls.some((c) => c.method === "PUT" && c.path === "/api/admin/candidates/N0000002")).toBe(false);
    });

    test("saved details are shown as saved (no suggestions over them); a custom size shows as Other", async () => {
        backend(SAVED_VIEW);
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        expect(screen.getByLabelText("Name according to passport")).toHaveValue("SAMAN K SILVA");
        expect(screen.getByLabelText("Permanent address")).toHaveValue("");
        expect(screen.queryByRole("note")).toBeNull();
        expect(screen.getByLabelText("T-shirt size")).toHaveValue("L");
        expect(screen.getByLabelText("Pant size")).toHaveValue("__custom");
        expect(screen.getByLabelText("Custom pant size")).toHaveValue("31");
        expect(screen.getByLabelText("Shoe size (UK)")).toHaveValue("9");
        expect(screen.getByLabelText("Father full name *")).toHaveValue("Sunil Silva");
        expect(screen.getByRole("button", { name: "Save additional details" })).toBeDisabled();
    });

    test("father, mother and wife details appear only with their answer, and the name is required", async () => {
        const { calls } = backend(NEW_VIEW);
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        const user = userEvent.setup();
        expect(screen.queryByLabelText("Father full name *")).toBeNull();
        expect(screen.queryByLabelText("Mother full name *")).toBeNull();
        expect(screen.queryByLabelText("Wife full name *")).toBeNull();

        await user.selectOptions(screen.getByLabelText("Is father alive?"), "yes");
        expect(screen.getByLabelText("Father full name *")).toBeInTheDocument();
        expect(screen.getByLabelText("Father birthday")).toBeInTheDocument();
        await user.selectOptions(screen.getByLabelText("Is mother alive?"), "no");
        expect(screen.queryByLabelText("Mother full name *")).toBeNull();
        await user.selectOptions(screen.getByLabelText("Marital status"), "MARRIED");
        expect(screen.getByLabelText("Wife full name *")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Save additional details" }));
        expect(await screen.findByText("Enter the father's full name.")).toBeInTheDocument();
        expect(screen.getByText("Enter the wife's full name.")).toBeInTheDocument();
        expect(puts(calls)).toHaveLength(0);
    });

    test("hidden details are cleared on save; sizes from presets or a custom value", async () => {
        const { calls } = backend(SAVED_VIEW, { [`PUT ${PATH}`]: { status: 200, body: SAVED_VIEW } });
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        const user = userEvent.setup();
        await user.selectOptions(screen.getByLabelText("Is father alive?"), "no");
        await user.selectOptions(screen.getByLabelText("Pant size"), "34");
        await user.selectOptions(screen.getByLabelText("Shoe size (UK)"), "__custom");
        await user.type(screen.getByLabelText("Custom shoe size (uk)"), "EU 43");
        await user.click(screen.getByRole("button", { name: "Save additional details" }));
        await vi.waitFor(() => expect(puts(calls)).toHaveLength(1));
        expect(puts(calls)[0].body).toMatchObject({ fatherAlive: false, fatherFullName: null, fatherBirthday: null, pantSize: "34", shoeSize: "EU 43", tshirtSize: "L" });
    });

    test("children in order, and a future birthday is refused before sending", async () => {
        const { calls } = backend(NEW_VIEW);
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("2nd child name"), "Kamala");
        await user.clear(screen.getByLabelText("Birthday"));
        await user.type(screen.getByLabelText("Birthday"), "2999-01-01");
        await user.click(screen.getByRole("button", { name: "Save additional details" }));
        expect(await screen.findByText("Enter the 1st child's name first.")).toBeInTheDocument();
        expect(screen.getByText("This date is in the future.")).toBeInTheDocument();
        expect(puts(calls)).toHaveLength(0);
    });

    test("the server's field errors are shown on their fields; other errors as a message", async () => {
        let reply = { status: 400, body: { message: "Invalid request body", errors: [{ field: "tshirtSize", message: "must be one of: XS, S, M, L, XL, XXL" }] } };
        backend(SAVED_VIEW, { [`PUT ${PATH}`]: () => reply });
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Other job skills"), "Welding");
        await user.click(screen.getByRole("button", { name: "Save additional details" }));
        expect(await screen.findByText("This value must be one of: XS, S, M, L, XL, XXL.")).toBeInTheDocument();
        expect(screen.getByText("Check the highlighted fields.")).toBeInTheDocument();

        reply = { status: 500, body: { message: "boom", errors: [] } };
        await user.click(screen.getByRole("button", { name: "Save additional details" }));
        expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    });

    test("a failed load shows the error with Try again", async () => {
        backend(NEW_VIEW, { [`GET ${PATH}`]: { status: 503, body: {} } });
        renderApp("/candidates/N0000002?tab=additional");
        expect(await screen.findByRole("button", { name: "Try again" }, RENDER_STEP)).toBeInTheDocument();
    });

    test("REGISTRATION_DESK can edit and save", async () => {
        const { calls } = backend(NEW_VIEW, { [`PUT ${PATH}`]: { status: 200, body: SAVED_VIEW } }, { ...ADMIN, role: "REGISTRATION_DESK" });
        renderApp("/candidates/N0000002");
        await openTab();
        const user = userEvent.setup();
        expect(screen.getByLabelText("T-shirt size")).toBeEnabled();
        await user.selectOptions(screen.getByLabelText("T-shirt size"), "M");
        await user.click(screen.getByRole("button", { name: "Save additional details" }));
        await vi.waitFor(() => expect(puts(calls)).toHaveLength(1));
    });

    test("a user without candidate permissions sees the details read-only", async () => {
        backend(SAVED_VIEW, {}, { ...ADMIN, role: "VIEWER" });
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        expect(screen.getByLabelText("T-shirt size")).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Save additional details" })).toBeNull();
    });
});

describe("progress stepper", () => {
    const stepper = () => within(screen.getByRole("navigation", { name: "Deployment stages" }));
    const labels = () => stepper().getAllByRole("button").map((b) => b.getAttribute("aria-label"));

    test("Additional details follows Candidate details; IVS interview and Finalizing the job have no circle", async () => {
        backend(NEW_VIEW);
        renderApp("/candidates/N0000002");
        await screen.findByRole("navigation", { name: "Deployment stages" }, RENDER_STEP);
        expect(labels()).toEqual([
            "1. Test details (incomplete)",
            "2. Candidate details (incomplete)",
            "3. Additional details (incomplete)",
            "4. Document submission (incomplete)",
            "5. Visa approval (incomplete)",
        ]);
    });

    test("its step shows the Additional details content and is the active step; another step shows that stage again", async () => {
        backend(NEW_VIEW);
        renderApp("/candidates/N0000002");
        await screen.findByRole("navigation", { name: "Deployment stages" }, RENDER_STEP);
        const user = userEvent.setup();
        await user.click(stepper().getByRole("button", { name: /^3\. Additional details/ }));
        expect(await screen.findByRole("form", { name: "Additional details" })).toBeInTheDocument();
        expect(stepper().getByRole("button", { name: /^3\. Additional details/ })).toHaveAttribute("aria-current", "step");

        await user.click(stepper().getByRole("button", { name: /^4\. Document submission/ }));
        expect(await screen.findByRole("heading", { name: "Document submission" })).toBeInTheDocument();
        expect(screen.queryByRole("form", { name: "Additional details" })).toBeNull();
        expect(stepper().getByRole("button", { name: /^4\. Document submission/ })).toHaveAttribute("aria-current", "step");
    });

    test("the step is completed when details are saved", async () => {
        backend(SAVED_VIEW);
        renderApp("/candidates/N0000002");
        await screen.findByRole("navigation", { name: "Deployment stages" }, RENDER_STEP);
        await vi.waitFor(() => expect(stepper().getByRole("button", { name: /^3\. Additional details/ })).toHaveAccessibleName(/\(completed/), RENDER_STEP);
    });

    test("the step turns completed right after Save", async () => {
        backend(NEW_VIEW, { [`PUT ${PATH}`]: { status: 200, body: SAVED_VIEW } });
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        expect(stepper().getByRole("button", { name: /^3\. Additional details/ })).toHaveAccessibleName("3. Additional details (incomplete)");
        await userEvent.setup().click(screen.getByRole("button", { name: "Save additional details" }));
        await vi.waitFor(() => expect(stepper().getByRole("button", { name: /^3\. Additional details/ })).toHaveAccessibleName(/\(completed/));
    });

    test("IVS interview and Finalizing the job stay reachable by link", async () => {
        backend(NEW_VIEW);
        renderApp("/candidates/N0000002?stage=FINALIZING_JOB");
        expect(await screen.findByRole("heading", { name: "Finalizing the job" }, RENDER_STEP)).toBeInTheDocument();
        expect(stepper().queryByRole("button", { current: "step" })).toBeNull();
    });
});

describe("one load, versions and resets", () => {
    const gets = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "GET" && c.path === PATH);
    const stepper = () => within(screen.getByRole("navigation", { name: "Deployment stages" }));

    test("the details are fetched once per candidate page, however often the step is opened", async () => {
        const { calls } = backend(SAVED_VIEW);
        renderApp("/candidates/N0000002");
        await screen.findByRole("navigation", { name: "Deployment stages" }, RENDER_STEP);
        const user = userEvent.setup();
        await user.click(stepper().getByRole("button", { name: /^3\. Additional details/ }));
        await screen.findByRole("form", { name: "Additional details" });
        await user.click(stepper().getByRole("button", { name: /^4\. Document submission/ }));
        await user.click(stepper().getByRole("button", { name: /^3\. Additional details/ }));
        await screen.findByRole("form", { name: "Additional details" });
        expect(gets(calls)).toHaveLength(1);
    });

    test("a save sends the version the form was loaded with", async () => {
        const { calls } = backend(SAVED_VIEW, { [`PUT ${PATH}`]: { status: 200, body: SAVED_VIEW } });
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Other job skills"), "Welding");
        await user.click(screen.getByRole("button", { name: "Save additional details" }));
        await vi.waitFor(() => expect(puts(calls)).toHaveLength(1));
        expect(puts(calls)[0].body).toMatchObject({ expectedUpdatedDate: SAVED_VIEW.updatedDate });
    });

    test("someone else saved first: the message is shown and the typed changes are kept", async () => {
        backend(SAVED_VIEW, { [`PUT ${PATH}`]: { status: 409, body: { message: "These details were changed by someone else after you opened them. Use Sync to load their changes, then try again.", code: "DETAILS_CHANGED" } } });
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Other job skills"), "Welding");
        await user.click(screen.getByRole("button", { name: "Save additional details" }));
        expect(await screen.findByText(/changed by someone else/)).toBeInTheDocument();
        expect(screen.getByLabelText("Other job skills")).toHaveValue("Welding");
        expect(screen.getByRole("button", { name: "Save additional details" })).toBeEnabled();
    });

    test("after a save, leaving the step and coming back shows the saved details and the next save uses the new version", async () => {
        const NEXT: AdditionalDetailsView = { ...SAVED_VIEW, details: { ...SAVED, otherJobSkills: "Welding" }, updatedDate: "2026-10-09T06:30:00.000Z" };
        const { calls } = backend(SAVED_VIEW, { [`PUT ${PATH}`]: { status: 200, body: NEXT } });
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Other job skills"), "Welding");
        await user.click(screen.getByRole("button", { name: "Save additional details" }));
        expect(await screen.findByText("Additional details saved.")).toBeInTheDocument();

        await user.click(stepper().getByRole("button", { name: /^4\. Document submission/ }));
        await user.click(stepper().getByRole("button", { name: /^3\. Additional details/ }));
        await screen.findByRole("form", { name: "Additional details" });
        expect(screen.getByLabelText("Other job skills")).toHaveValue("Welding");

        await user.type(screen.getByLabelText("1st child name"), "Nimal");
        await user.click(screen.getByRole("button", { name: "Save additional details" }));
        await vi.waitFor(() => expect(puts(calls)).toHaveLength(2));
        expect(puts(calls)[1].body).toMatchObject({ expectedUpdatedDate: NEXT.updatedDate });
        expect(gets(calls)).toHaveLength(1);
    });

    test("Cancel restores a preset size and its select, after Other had been chosen", async () => {
        backend(SAVED_VIEW);
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        const user = userEvent.setup();
        expect(screen.getByLabelText("Shoe size (UK)")).toHaveValue("9");
        await user.selectOptions(screen.getByLabelText("Shoe size (UK)"), "__custom");
        await user.type(screen.getByLabelText("Custom shoe size (uk)"), "EU 43");
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.getByLabelText("Shoe size (UK)")).toHaveValue("9");
        expect(screen.queryByLabelText("Custom shoe size (uk)")).toBeNull();
    });

    test("another candidate's details never show on this one: the step stays incomplete until its own load arrives", async () => {
        // Candidate B's additional details are held back; A's say "saved".
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const B_DETAILS = { ...DETAILS, candidate: { ...DETAILS.candidate, passportId: "N0000003", uniqueId: "0003", name: "NIMAL FERNANDO" } };
        backend(SAVED_VIEW, {
            "GET /api/admin/candidates/N0000003": { status: 200, body: B_DETAILS },
            "GET /api/admin/candidates/N0000003/additional-details": async () => {
                await held;
                return { status: 200, body: { passportId: "N0000003", details: null, suggested: SUGGESTED, updatedDate: null } };
            },
        });
        let go!: (to: string) => void;
        function Probe() {
            go = useNavigate();
            return null;
        }
        render(
            <MemoryRouter initialEntries={["/candidates/N0000002"]}>
                <AuthProvider>
                    <AppRoutes />
                    <Probe />
                </AuthProvider>
            </MemoryRouter>,
        );
        const nav = () => within(screen.getByRole("navigation", { name: "Deployment stages" }));
        await vi.waitFor(() => expect(nav().getByRole("button", { name: /^3\. Additional details/ })).toHaveAccessibleName(/\(completed/), RENDER_STEP);

        act(() => go("/candidates/N0000003"));
        expect(await screen.findByRole("heading", { name: "NIMAL FERNANDO" }, RENDER_STEP)).toBeInTheDocument();
        expect(nav().getByRole("button", { name: /^3\. Additional details/ })).toHaveAccessibleName("3. Additional details (incomplete)");
        release();
    });
});
