import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { CANDIDATE_STAGES, type AdditionalDetails, type AdditionalDetailsView, type CandidateDetails } from "../api/candidates";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// Candidate > Additional Details tab. Synthetic data only; the backend is stubbed.

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

const openTab = async () => {
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Additional Details" }, RENDER_STEP));
    return screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
};
const puts = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method === "PUT" && c.path === PATH);

describe("Additional Details tab", () => {
    test("is a tab next to Deployment; the stages stay on Deployment", async () => {
        backend(NEW_VIEW);
        renderApp("/candidates/N0000002");
        const tabs = await screen.findByRole("tablist", { name: "Candidate sections" }, RENDER_STEP);
        expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Deployment", "Additional Details"]);
        expect(within(tabs).getByRole("tab", { name: "Deployment" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("navigation", { name: "Deployment stages" })).toBeInTheDocument();

        await openTab();
        expect(screen.getByRole("tab", { name: "Additional Details" })).toHaveAttribute("aria-selected", "true");
        expect(screen.queryByRole("navigation", { name: "Deployment stages" })).toBeNull();
        for (const section of ["Passport & personal details", "Clothing & sizes", "Father details", "Mother details", "Marital & family details", "Employment / skills"]) {
            expect(screen.getByRole("group", { name: section })).toBeInTheDocument();
        }
        await userEvent.setup().click(screen.getByRole("tab", { name: "Deployment" }));
        expect(await screen.findByRole("navigation", { name: "Deployment stages" })).toBeInTheDocument();
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
        expect(puts(calls)[0].body).toEqual({ ...EMPTY, ...SUGGESTED });
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
