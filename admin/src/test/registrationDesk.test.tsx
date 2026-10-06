import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { ADMIN, OVERVIEW, TOKEN_KEY, fakeJwt, renderApp, stubBackend } from "./helpers";

// REGISTRATION_DESK in the UI: one page, Add candidate, which registers new
// candidates only. The frontend is not the security boundary (the backend's
// role rules are in test/registrationDeskRbac.test.js and
// test/candidates.test.js); these tests pin what the UI shows and asks for.

const DESK = { ...ADMIN, adminId: "desk-1", name: "Front Desk", role: "REGISTRATION_DESK" };
const DENIED = { status: 403, body: { message: "Insufficient permissions" } };
const GRANT = "registration-upload-grant";
const UPLOAD_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const SIGNED_PATH = "/storage/v1/object/upload/sign/documents/clients/N0000002/passport/upload_staged.pdf";

function signedInAs(admin: typeof DESK | typeof ADMIN, routes: Parameters<typeof stubBackend>[0] = {}) {
    window.sessionStorage.setItem(TOKEN_KEY, fakeJwt());
    // What the backend answers the desk outside registration.
    return stubBackend({
        "GET /auth/me": { status: 200, body: { admin } },
        "GET /api/admin/overview": DENIED,
        "GET /api/admin/review": DENIED,
        "GET /api/admin/candidates": DENIED,
        ...routes,
    });
}

const sidebarLinks = () => within(screen.getByRole("navigation", { name: "Main navigation" })).getAllByRole("link").map((a) => a.textContent?.trim());

async function fillRegistration(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText("Surname *"), "SILVA");
    await user.type(screen.getByLabelText("Other names *"), "SAMAN");
    await user.type(screen.getByLabelText("NIC *"), "901234567V");
    await user.type(screen.getByLabelText("Passport ID *"), "n0000002");
    await user.type(screen.getByLabelText("Job type *"), "Driver{Enter}");
    await user.type(screen.getByLabelText("Job experience *"), "5 years");
    await user.type(screen.getByLabelText("WhatsApp number *"), "0771234567");
}

describe("REGISTRATION_DESK: sign-in and navigation", () => {
    test("after sign-in the desk lands on Add candidate, not the dashboard", async () => {
        const { calls } = stubBackend({
            "POST /auth/login": { status: 200, body: { message: "Login successful", token: fakeJwt() } },
            "GET /auth/me": { status: 200, body: { admin: DESK } },
            "GET /api/admin/overview": DENIED,
        });
        renderApp("/login");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Email"), DESK.email);
        await user.type(screen.getByLabelText("Password"), "Correct-Horse-7");
        await user.click(screen.getByRole("button", { name: "Sign in" }));

        expect(await screen.findByRole("heading", { name: "Add candidate" })).toBeInTheDocument();
        expect(screen.getByText("REGISTRATION_DESK")).toBeInTheDocument();
        expect(calls.some((c) => c.path.startsWith("/api/admin/overview"))).toBe(false);
    });

    test("the sidebar has Add Candidate only; no other link, notification or business data is shown or fetched", async () => {
        const { calls } = signedInAs(DESK);
        renderApp("/candidates/new");
        await screen.findByRole("heading", { name: "Add candidate" });
        expect(sidebarLinks()).toEqual(["Add Candidate"]);
        // The page's only links: the sidebar entry (no header shortcut, no Candidates breadcrumb).
        expect(screen.getAllByRole("link").map((a) => a.textContent?.trim())).toEqual(["Add Candidate"]);
        expect(screen.queryByRole("button", { name: /notification/i })).not.toBeInTheDocument();
        for (const text of [/Total clients/i, /Pending review/i, /Received today/i, /Candidate pool/i, /Review Queue/i, /Daily Report/i, /Invite Admin/i, /Change Roles/i]) {
            expect(screen.queryByText(text)).not.toBeInTheDocument();
        }
        expect(calls.filter((c) => c.path.startsWith("/api/")).map((c) => c.path)).toEqual([]);
    });

    test("a browser refresh keeps the desk on Add candidate (the role comes from /auth/me again)", async () => {
        // A fresh load with the stored session: on the allowed page, and on the dashboard URL.
        for (const route of ["/candidates/new", "/"]) {
            const { calls } = signedInAs(DESK);
            const { unmount } = renderApp(route);
            expect(await screen.findByRole("heading", { name: "Add candidate" })).toBeInTheDocument();
            expect(calls.map((c) => c.path)).toEqual(["/auth/me"]);
            unmount();
        }
    });

    test("Sign out works and returns to the sign-in page", async () => {
        signedInAs(DESK, { "POST /auth/logout": { status: 200, body: { message: "Signed out" } } });
        renderApp("/candidates/new");
        await screen.findByRole("heading", { name: "Add candidate" });
        await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    });

    test.each([
        "/", "/documents", "/review", "/review/3f2b8c1e-0000-4000-8000-000000000001", "/candidates", "/candidates/N1234567",
        "/clients", "/clients/N1234567", "/missing-documents", "/police", "/reports/daily", "/invitations", "/roles", "/settings", "/no-such-page",
    ])("%s sends the desk to Add candidate without asking the API", async (route) => {
        const { calls } = signedInAs(DESK);
        renderApp(route);
        expect(await screen.findByRole("heading", { name: "Add candidate" })).toBeInTheDocument();
        expect(calls.filter((c) => c.path.startsWith("/api/")).map((c) => c.path)).toEqual([]);
    });
});

describe("REGISTRATION_DESK: registering", () => {
    test("the passport ID is never looked up, so no existing record is loaded into the form", async () => {
        const { calls } = signedInAs(DESK);
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Passport ID *"), "N1234567");
        await user.tab();
        expect(calls.some((c) => c.method === "GET" && c.path.startsWith("/api/admin/candidates/"))).toBe(false);
        expect(screen.queryByText(/Existing candidate found/)).not.toBeInTheDocument();
    });

    test("registers a new candidate, uploads the passport with the grant, and confirms here", async () => {
        const { calls } = signedInAs(DESK, {
            "POST /api/admin/candidates": { status: 201, body: { passportId: "N0000002", uniqueId: "0002", registrationUploadGrant: GRANT } },
            "POST /api/admin/candidates/N0000002/documents/upload-target": { status: 200, body: { uploadId: UPLOAD_ID, uploadUrl: `https://project.supabase.co${SIGNED_PATH}?token=signed`, maxFileSize: 10485760 } },
            [`PUT ${SIGNED_PATH}`]: { status: 200, body: {} },
            "POST /api/admin/candidates/N0000002/documents/finalize": { status: 200, body: { passportId: "N0000002", documentType: "PASSPORT", stored: true } },
        });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await fillRegistration(user);
        await user.upload(screen.getByLabelText("Passport"), new File(["%PDF-1.4"], "passport.pdf", { type: "application/pdf" }));
        await user.click(screen.getByRole("button", { name: "Register candidate" }));

        expect(await screen.findByRole("heading", { name: "Candidate registered" })).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent("N0000002");
        const uploads = calls.filter((c) => c.path.startsWith("/api/") && c.path.includes("/documents/"));
        expect(uploads.map((c) => c.path)).toEqual(["/api/admin/candidates/N0000002/documents/upload-target", "/api/admin/candidates/N0000002/documents/finalize"]);
        for (const c of uploads) expect(c.headers["X-Registration-Upload"]).toBe(GRANT);
        // Never the candidate's page or record.
        expect(calls.some((c) => c.method === "GET" && c.path.startsWith("/api/admin/candidates"))).toBe(false);
        expect(screen.queryByRole("navigation", { name: "Deployment stages" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Register another candidate" }));
        expect(await screen.findByRole("heading", { name: "Add candidate" })).toBeInTheDocument();
        expect(screen.getByLabelText("Passport ID *")).toHaveValue("");
    });

    test("a refused upload is listed for an analyst to add later", async () => {
        signedInAs(DESK, {
            "POST /api/admin/candidates": { status: 201, body: { passportId: "N0000002", uniqueId: "0002", registrationUploadGrant: GRANT } },
            "POST /api/admin/candidates/N0000002/documents/upload-target": DENIED,
        });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await fillRegistration(user);
        await user.upload(screen.getByLabelText("Passport"), new File(["%PDF-1.4"], "passport.pdf", { type: "application/pdf" }));
        await user.click(screen.getByRole("button", { name: "Register candidate" }));
        expect(await screen.findByRole("alert")).toHaveTextContent(/Passport: Insufficient permissions/);
    });

    test("an already-registered passport ID shows the refusal only: no lookup, no link, no record", async () => {
        const { calls } = signedInAs(DESK, {
            "POST /api/admin/candidates": { status: 409, body: { message: "Candidate already exists.", code: "CANDIDATE_EXISTS" } },
        });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await fillRegistration(user);
        await user.click(screen.getByRole("button", { name: "Register candidate" }));

        expect(await screen.findByText("Candidate already exists.")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Open the registered candidate" })).not.toBeInTheDocument();
        expect(screen.queryByText(/Existing candidate found/)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Register candidate" })).toBeInTheDocument();
        expect(calls.some((c) => c.method === "GET" && c.path.startsWith("/api/admin/candidates/"))).toBe(false);
        expect(calls.some((c) => c.method === "PUT")).toBe(false);
    });

    test("Cancel clears the form and stays on the page", async () => {
        signedInAs(DESK);
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Surname *"), "SILVA");
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.getByRole("heading", { name: "Add candidate" })).toBeInTheDocument();
        expect(screen.getByLabelText("Surname *")).toHaveValue("");
    });
});

describe("other roles are unchanged", () => {
    test("ADMIN keeps the full sidebar, Invite Admin and Change Roles included", async () => {
        signedInAs(ADMIN, { "GET /api/admin/overview": { status: 200, body: {} }, "GET /api/admin/candidates": { status: 200, body: { items: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 }, filters: { search: null } } } });
        renderApp("/candidates");
        await screen.findByText(ADMIN.name);
        expect(sidebarLinks()).toEqual(["Overview", "Documents", "Review Queue", "Candidates", "Missing Documents", "Police Workflow", "Daily Report", "Invite Admin", "Change Roles"]);
    });

    test("MANAGER keeps the dashboard sidebar and lands on Overview after sign-in", async () => {
        stubBackend({
            "POST /auth/login": { status: 200, body: { message: "Login successful", token: fakeJwt() } },
            "GET /auth/me": { status: 200, body: { admin: { ...ADMIN, role: "MANAGER" } } },
            "GET /api/admin/overview": { status: 200, body: OVERVIEW },
        });
        renderApp("/login");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Email"), ADMIN.email);
        await user.type(screen.getByLabelText("Password"), "Correct-Horse-7");
        await user.click(screen.getByRole("button", { name: "Sign in" }));
        await screen.findByText("MANAGER");
        expect(sidebarLinks()).toEqual(["Overview", "Documents", "Review Queue", "Candidates", "Missing Documents", "Police Workflow", "Daily Report"]);
        expect(screen.queryByRole("heading", { name: "Add candidate" })).not.toBeInTheDocument();
    });

    test("an ANALYST's Add candidate still looks the passport ID up", async () => {
        const { calls } = signedInAs({ ...ADMIN, role: "ANALYST" }, { "GET /api/admin/candidates/N1234567": { status: 404, body: { message: "Candidate not found" } } });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Passport ID *"), "N1234567");
        await user.tab();
        await waitFor(() => expect(calls.some((c) => c.method === "GET" && c.path === "/api/admin/candidates/N1234567")).toBe(true));
    });
});
