import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test } from "vitest";
import type { ClientList, ClientListItem, PoliceList } from "../api/admin";
import { todayInSriLanka } from "../components/format";
import { THEME_KEY, initTheme } from "../theme/theme";
import { readFileSync } from "node:fs";
import { ADMIN, CLIENT_DETAILS, OVERVIEW, renderApp, signedInBackend } from "./helpers";

// Synthetic clients and figures only.
const row = (passportId: string, uniqueId: string, name: string, completion: "COMPLETE" | "INCOMPLETE", missing: string[] = []): ClientListItem => ({
    client: { passportId, uniqueId, name, whatsappNumber: "94770000000" },
    completion,
    requirements: ["PASSPORT", "POLICE_REPORT", "MEDICAL"].map((documentType) => ({
        documentType, status: missing.includes(documentType) ? "MISSING" : "VERIFIED", storedCount: missing.includes(documentType) ? 0 : 1, pendingCount: 0,
    })),
    missingDocumentTypes: missing,
});
const clientList = (items: ClientListItem[], { page = 1, total = items.length } = {}): ClientList => ({
    items,
    pagination: { page, pageSize: 25, total, totalPages: Math.max(1, Math.ceil(total / 25)) },
    summary: { total: 3, complete: 1, incomplete: 2, withMissing: 2, missingDocuments: 3, missingByType: { PASSPORT: 0, POLICE_REPORT: 1, MEDICAL: 2 } },
    requiredDocumentTypes: ["PASSPORT", "POLICE_REPORT", "MEDICAL"],
});
const CLIENTS = clientList([
    row("N0000001", "0001", "KAMAL PERERA", "COMPLETE"),
    row("N0000002", "0002", "SAMAN SILVA", "INCOMPLETE", ["MEDICAL"]),
    row("N0000003", "0003", "NIMALI", "INCOMPLETE", ["POLICE_REPORT", "MEDICAL"]),
]);
const lastPath = (calls: { path: string }[], prefix: string) => [...calls].reverse().find((c) => c.path.startsWith(prefix))?.path;

describe("Clients directory", () => {
    test("replaces the placeholder: summary, rows with required documents, link to the client", async () => {
        signedInBackend({ "GET /api/admin/clients": { status: 200, body: CLIENTS } });
        renderApp("/clients");
        const table = await screen.findByRole("table", { name: "Clients" });
        expect(screen.queryByText(/Not connected yet/)).not.toBeInTheDocument();
        expect(within(table).getAllByRole("row")).toHaveLength(4);
        expect(within(table).getByText("SAMAN SILVA")).toBeInTheDocument();
        expect(within(table).getAllByText("Complete")).toHaveLength(1);
        expect(within(table).getAllByText("Incomplete")).toHaveLength(2);
        expect(within(table).getByText("Police report, Medical")).toBeInTheDocument();
        expect(within(table).getAllByRole("link", { name: "View client" })[1]).toHaveAttribute("href", "/clients/N0000002");
        expect(screen.getByRole("button", { name: /Complete\s*1/ })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Incomplete\s*2/ })).toBeInTheDocument();
    });

    test("search, completion and missing-type filters and pagination go to the API", async () => {
        const { calls } = signedInBackend({ "GET /api/admin/clients": (url) => ({ status: 200, body: clientList(CLIENTS.items, { page: Number(url.searchParams.get("page") ?? 1), total: 60 }) }) });
        renderApp("/clients");
        const user = userEvent.setup();
        await screen.findByRole("table", { name: "Clients" });
        await user.type(screen.getByLabelText("Search clients"), "0770000002");
        await user.click(screen.getByRole("button", { name: "Search" }));
        expect(lastPath(calls, "/api/admin/clients")).toBe("/api/admin/clients?page=1&pageSize=25&search=0770000002");
        await user.selectOptions(screen.getByLabelText("Completion"), "INCOMPLETE");
        await user.selectOptions(screen.getByLabelText("Missing document"), "MEDICAL");
        expect(lastPath(calls, "/api/admin/clients")).toBe("/api/admin/clients?page=1&pageSize=25&search=0770000002&completion=INCOMPLETE&missingType=MEDICAL");
        await user.click(await screen.findByRole("button", { name: "Next" }));
        expect(lastPath(calls, "/api/admin/clients")).toContain("page=2");
    });

    test("empty, loading and error states", async () => {
        signedInBackend({ "GET /api/admin/clients": { status: 200, body: clientList([]) } });
        renderApp("/clients?search=nobody");
        expect(await screen.findByText("No clients match these filters")).toBeInTheDocument();
    });

    test("server error -> error state with retry", async () => {
        signedInBackend({ "GET /api/admin/clients": { status: 500, body: {} } });
        renderApp("/clients");
        expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    });
});

describe("Missing Documents view", () => {
    test("incomplete clients, missing per type, filter by type", async () => {
        const { calls } = signedInBackend({ "GET /api/admin/documents/missing": { status: 200, body: clientList(CLIENTS.items.slice(1)) } });
        renderApp("/missing-documents");
        const table = await screen.findByRole("table", { name: "Incomplete clients" });
        expect(within(table).getAllByRole("row")).toHaveLength(3);
        const medical = screen.getByRole("button", { name: /Missing medical\s*2/ });
        await userEvent.setup().click(medical);
        expect(lastPath(calls, "/api/admin/documents/missing")).toBe("/api/admin/documents/missing?page=1&pageSize=25&documentType=MEDICAL");
        expect(within(screen.getByRole("navigation", { name: "Main navigation" })).getByRole("link", { name: "Missing Documents" })).toHaveAttribute("aria-current", "page");
    });

    test("everyone complete -> empty state", async () => {
        signedInBackend({ "GET /api/admin/documents/missing": { status: 200, body: clientList([]) } });
        renderApp("/missing-documents");
        expect(await screen.findByText("Every client is complete")).toBeInTheDocument();
    });
});

// The Daily Report page is tested in dailyReport.test.tsx.

describe("Police Workflow search", () => {
    const LIST: PoliceList = {
        businessDate: "2026-09-25", items: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
        summary: { total: 0, byStatus: { OVERDUE: 0, DUE_TODAY: 0, DUE_SOON: 0, PENDING: 0, DATE_MISSING: 0, NOT_UPLOADED: 0, COMPLETED: 0 } },
    };

    test("the search is sent with the status filter; empty result explains it", async () => {
        const { calls } = signedInBackend({ "GET /api/admin/police": { status: 200, body: LIST } });
        renderApp("/police?status=OVERDUE");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Search clients"), "N0000002");
        await user.click(screen.getByRole("button", { name: "Search" }));
        expect(lastPath(calls, "/api/admin/police")).toBe("/api/admin/police?page=1&pageSize=25&status=OVERDUE&search=N0000002");
        expect(await screen.findByText(/No clients match "N0000002"/)).toBeInTheDocument();
    });
});

describe("Client Details: police slip date", () => {
    const WITH_SLIP = {
        ...CLIENT_DETAILS,
        police: {
            ...CLIENT_DETAILS.police,
            latestSlip: { documentId: "cccc0000-0000-4000-8000-000000000003", receivedDate: "2026-09-10T03:00:00.000Z", verificationStatus: "VERIFIED", policeSubmittedDate: null },
            latestReport: null,
            countdown: { status: "DATE_MISSING" as const, submittedDate: null, dueDate: null, daysRemaining: null, slip: null, report: null, slipAwaitingReview: false },
        },
    };

    test("set a date: validated, sent with a reason, page reloaded with the history", async () => {
        let saved = false;
        const { calls } = signedInBackend({
            "GET /api/admin/clients/N1234567": () => ({ status: 200, body: saved ? { ...WITH_SLIP, police: { ...WITH_SLIP.police, dateChanges: [{ auditId: "a1", documentId: "x", adminName: "Test Admin", previousDate: null, newDate: "2026-09-10", reason: "Read from slip", createdDate: "2026-09-25T05:00:00.000Z" }] } } : WITH_SLIP }),
            "POST /api/admin/documents/cccc0000-0000-4000-8000-000000000003/police-date": () => { saved = true; return { status: 200, body: {} }; },
        });
        renderApp("/clients/N1234567");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Set date" }));
        const dialog = screen.getByRole("dialog", { name: "Set the police slip date" });
        const input = within(dialog).getByLabelText(/Submitted date/);
        // Not in the future: the calendar disables tomorrow (Escape closes only the calendar, not this dialog).
        await user.click(within(dialog).getByRole("button", { name: "Open calendar" }));
        expect(await screen.findByRole("button", { name: new Date(Date.parse(`${todayInSriLanka()}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) })).toBeDisabled();
        await user.keyboard("{Escape}");
        expect(screen.getByRole("dialog", { name: "Set the police slip date" })).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Save date" }));
        expect(within(dialog).getByText(/Enter the submitted date/)).toBeInTheDocument();
        await user.type(input, "2026-09-10");
        await user.click(within(dialog).getByRole("button", { name: "Save date" }));
        expect(within(dialog).getByText("Enter a reason.")).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
        await user.type(within(dialog).getByLabelText(/Reason/), "Read from slip");
        await user.click(within(dialog).getByRole("button", { name: "Save date" }));
        expect(await screen.findByRole("status")).toHaveTextContent("Police slip submitted date set to 10 Sept 2026");
        expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ policeSubmittedDate: "2026-09-10", reason: "Read from slip" }]);
        expect(await screen.findByRole("list", { name: "Police slip date changes" })).toHaveTextContent("Test Admin");
    });

    test("a future date is refused before anything is sent", async () => {
        const { calls } = signedInBackend({ "GET /api/admin/clients/N1234567": { status: 200, body: WITH_SLIP } });
        renderApp("/clients/N1234567");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Set date" }));
        const dialog = screen.getByRole("dialog");
        await user.type(within(dialog).getByLabelText(/Submitted date/), "2999-01-01");
        await user.type(within(dialog).getByLabelText(/Reason/), "x");
        await user.click(within(dialog).getByRole("button", { name: "Save date" }));
        expect(within(dialog).getByText("The date can't be in the future.")).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });

    test("ANALYST cannot see the set-date button (requires ADMIN)", async () => {
        signedInBackend({
            "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role: "ANALYST" } } },
            "GET /api/admin/clients/N1234567": { status: 200, body: WITH_SLIP },
        });
        renderApp("/clients/N1234567");
        expect(await screen.findByRole("heading", { name: "KAMAL NIMAL PERERA" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Set date" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Correct date" })).not.toBeInTheDocument();
    });

    test("complete / incomplete badge and the Clients breadcrumb", async () => {
        signedInBackend({ "GET /api/admin/clients/N1234567": { status: 200, body: CLIENT_DETAILS } });
        renderApp("/clients/N1234567");
        expect(await screen.findByText("Incomplete")).toBeInTheDocument();
        const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
        expect(within(breadcrumb).getByRole("link", { name: "Clients" })).toHaveAttribute("href", "/clients");
    });
});

describe("Overview completeness", () => {
    test("completed, incomplete and missing documents link to their views", async () => {
        signedInBackend();
        renderApp("/");
        const list = await screen.findByRole("list", { name: "Clients by completeness" });
        expect(within(list).getByRole("link", { name: /Completed clients\s*1,200/ })).toHaveAttribute("href", "/clients?completion=COMPLETE");
        expect(within(list).getByRole("link", { name: /Incomplete clients\s*228/ })).toBeInTheDocument();
        expect(within(list).getByRole("link", { name: /Missing documents\s*190/ })).toHaveAttribute("href", "/missing-documents");
        expect(screen.getByRole("list", { name: "Police reports by status" })).toBeInTheDocument();
    });
});

describe("Sync", () => {
    test("reloads the data on screen, keeps the filters, shows progress and the result", async () => {
        let release: () => void = () => {};
        let hold = false;
        const { calls } = signedInBackend({
            "GET /api/admin/clients": () => (hold ? new Promise((resolve) => { release = () => resolve({ status: 200, body: CLIENTS }); }) : { status: 200, body: CLIENTS }),
        });
        renderApp("/clients?completion=INCOMPLETE");
        const user = userEvent.setup();
        await screen.findByRole("table", { name: "Clients" });
        const before = calls.filter((c) => c.path.startsWith("/api/admin/clients")).length;

        hold = true;
        const button = screen.getByRole("button", { name: "Sync" });
        await user.click(button);
        const busy = screen.getByRole("button", { name: "Syncing…" });
        expect(busy).toBeDisabled();
        await user.click(busy).catch(() => {});
        const during = calls.filter((c) => c.path.startsWith("/api/admin/clients"));
        expect(during.length - before).toBe(1); // one reload, not two
        expect(during.at(-1)!.path).toBe("/api/admin/clients?page=1&pageSize=25&completion=INCOMPLETE");

        await act(async () => release());
        expect(await screen.findByTestId("sync-status")).toHaveTextContent(/Synced \d\d:\d\d:\d\d/);
        expect(screen.getByRole("button", { name: "Sync" })).toBeEnabled();
    });

    test("a failed reload is reported", async () => {
        let fail = false;
        signedInBackend({ "GET /api/admin/overview": () => (fail ? { status: 500, body: {} } : { status: 200, body: OVERVIEW }) });
        renderApp("/");
        await screen.findByText("1,428");
        fail = true;
        await userEvent.setup().click(screen.getByRole("button", { name: "Sync" }));
        expect(await screen.findByTestId("sync-status")).toHaveTextContent("Sync failed");
    });
});

// WCAG relative luminance / contrast of #rrggbb colours.
function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
};
const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8"); // vitest runs in admin/
function tokens(block: string): Record<string, string> {
    return Object.fromEntries([...block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}
const LIGHT = tokens(css.slice(css.indexOf("@theme"), css.indexOf(":root[data-theme")));
const DARK = { ...LIGHT, ...tokens(css.slice(css.indexOf(":root[data-theme=\"dark\"]"), css.indexOf("@layer base"))) };

describe("Dark mode", () => {
    afterEach(() => {
        window.localStorage.clear();
        delete document.documentElement.dataset.theme;
    });

    test("the header toggle switches the theme and remembers it; light is the default", async () => {
        window.localStorage.clear();
        expect(initTheme()).toBe("light");
        signedInBackend();
        renderApp("/");
        const toggle = await screen.findByRole("button", { name: "Dark mode" });
        expect(toggle).toHaveAttribute("aria-pressed", "false");
        await userEvent.setup().click(toggle);
        expect(document.documentElement.dataset.theme).toBe("dark");
        expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
        expect(toggle).toHaveAttribute("aria-pressed", "true");
        // After a reload the stored choice is applied before the first render.
        delete document.documentElement.dataset.theme;
        expect(initTheme()).toBe("dark");
        expect(document.documentElement.dataset.theme).toBe("dark");
        await userEvent.setup().click(toggle);
        expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
    });

    test("blocked storage falls back to light mode", () => {
        const original = window.localStorage.getItem;
        window.localStorage.getItem = () => { throw new Error("blocked"); };
        try {
            expect(initTheme()).toBe("light");
        } finally {
            window.localStorage.getItem = original;
        }
    });

    test("every text colour is readable (WCAG AA 4.5:1) on every surface, in both themes", () => {
        const texts = ["ink", "ink-soft", "ink-muted", "ink-subtle", "primary"];
        const surfaces = ["page", "surface", "canvas", "canvas-muted"];
        for (const [name, theme] of [["light", LIGHT], ["dark", DARK]] as const) {
            for (const text of texts) {
                for (const surface of surfaces) {
                    expect(contrast(theme[text], theme[surface]), `${name}: ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
                }
            }
        }
    });

    test("dark mode: status colours on their tints, text on solid buttons, sidebar text", () => {
        for (const tone of ["verified", "review", "pending", "critical", "duplicate"]) {
            expect(contrast(DARK[tone], DARK[`${tone}-bg`]), tone).toBeGreaterThanOrEqual(4.5);
            expect(contrast(DARK[tone], DARK.surface), `${tone} on surface`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(DARK["on-primary"], DARK.primary)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(DARK["on-critical"], DARK.critical)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(DARK["sidebar-text"], DARK.sidebar)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(DARK["sidebar-text-active"], DARK["sidebar-hover"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(DARK.primary, DARK["primary-soft"])).toBeGreaterThanOrEqual(4.5);
    });

    test("light mode's layers can be told apart: surface from page, canvas from both, and controls have a 3:1 outline", () => {
        expect(contrast(LIGHT.surface, LIGHT.page)).toBeGreaterThanOrEqual(1.1);
        expect(contrast(LIGHT.surface, LIGHT.canvas)).toBeGreaterThanOrEqual(1.2);
        expect(contrast(LIGHT.page, LIGHT.canvas)).toBeGreaterThanOrEqual(1.1);
        expect(contrast(LIGHT.page, LIGHT.border)).toBeGreaterThanOrEqual(1.3);
        expect(contrast(LIGHT["border-strong"], LIGHT.surface)).toBeGreaterThanOrEqual(3);
    });

    test("light mode carries the EMLYNK identity: near-black primary, slate sidebar, 10px radius, Montserrat headings", () => {
        expect(LIGHT).toMatchObject({ primary: "#171717", page: "#f0f0f0", surface: "#ffffff", canvas: "#e5e5e5", border: "#d4d4d4", ink: "#0a0a0a", sidebar: "#1f242b", accent: "#ef4444", "on-primary": "#fafafa" });
        expect(css).toContain("--radius: 0.625rem");
        expect(css).toContain('--font-heading: "Montserrat Variable"');
    });

    test("dark mode is the brand slate surface", () => {
        expect(DARK).toMatchObject({ page: "#1f242b", surface: "#262c34", border: "#353c46", sidebar: "#1f242b" });
    });

    test("no text token is below 12px, and the old classic overrides are gone", () => {
        const sizes = [...css.matchAll(/--text-[a-z]+-[a-z]+:\s*(\d+)px/g)].map((match) => Number(match[1]));
        expect(sizes.length).toBeGreaterThan(0);
        expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
        expect(css).not.toContain("ui-classic");
    });

    test("components use tokens, not fixed colours that break in dark mode", () => {
        const sources = import.meta.glob("../**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
        for (const [file, code] of Object.entries(sources)) {
            if (file.includes("/test/")) continue;
            expect(code, file).not.toMatch(/\b(text|bg|border)-(white|black|slate-\d+|gray-\d+)\b|bg-ink\/|#[0-9a-f]{6}\b/i);
        }
    });
});
