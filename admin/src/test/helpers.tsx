import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import type { ClientDetails, DocumentItem, DocumentList, Overview } from "../api/admin";
import { AppRoutes } from "../App";
import { AuthProvider } from "../auth/AuthProvider";

// Synthetic admin, tokens, clients and documents only.
export const ADMIN = { adminId: "admin-1", email: "admin@example.invalid", name: "Test Admin", role: "ADMIN", status: "ACTIVE" };
export const TOKEN_KEY = "emlynk.admin.token";

// A JWT-shaped string with the given expiry (signature not checked here).
export function fakeJwt(expiresInSeconds = 3600): string {
    const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const now = Math.floor(Date.now() / 1000);
    return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ adminId: ADMIN.adminId, iat: now, exp: now + expiresInSeconds })}.signature`;
}

type Route = { status: number; body?: unknown };
type RouteHandler = Route | ((url: URL) => Route | Promise<Route>);
// Keys are "METHOD /path" (the path without the query string).
export type FetchRoutes = Record<string, RouteHandler>;

// Stub for the backend; records every request.
export function stubBackend(routes: FetchRoutes) {
    const calls: { method: string; path: string; url: URL; headers: Record<string, string>; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input), "http://localhost");
        const method = init.method ?? "GET";
        calls.push({ method, path: url.pathname + url.search, url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
        const route = routes[`${method} ${url.pathname}`];
        const { status, body } = typeof route === "function" ? await route(url) : route ?? { status: 404, body: { message: "Not found" } };
        return new Response(JSON.stringify(body ?? {}), { status, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls, fetchMock };
}

export function renderApp(initialPath = "/") {
    return render(
        <MemoryRouter initialEntries={[initialPath]}>
            <AuthProvider>
                <AppRoutes />
            </AuthProvider>
        </MemoryRouter>
    );
}

// Signed-in session: stored token + GET /auth/me, plus any other routes.
export function signedInBackend(routes: FetchRoutes = {}) {
    window.sessionStorage.setItem(TOKEN_KEY, fakeJwt());
    return stubBackend({ "GET /auth/me": { status: 200, body: { admin: ADMIN } }, "GET /api/admin/overview": { status: 200, body: OVERVIEW }, ...routes });
}

export const CLIENT_REF = { passportId: "N1234567", uniqueId: "0001", name: "KAMAL NIMAL PERERA" };

export const makeDocument = (overrides: Partial<DocumentItem> = {}): DocumentItem => ({
    documentId: "3f2b8c1e-0000-4000-8000-000000000001",
    documentType: "PASSPORT",
    processingStatus: "STORED",
    verificationStatus: "VERIFIED",
    ocrConfidence: 97.5,
    receivedDate: "2026-09-24T07:05:03.000Z",
    storedFilename: "passport.pdf",
    mimeType: "application/pdf",
    fileSize: 123456,
    client: CLIENT_REF,
    ...overrides,
});

export const OVERVIEW: Overview = {
    businessDate: "2026-09-25",
    kpis: { totalClients: 1428, totalDocuments: 8942, pendingReview: 17, receivedToday: 42 },
    submissionsByStatus: { VERIFIED: 30, MANUAL_REVIEW: 8, DUPLICATE: 2 },
    submissionsByType: { PASSPORT: 20, POLICE_REPORT: 12, MEDICAL: 8 },
    recentDocuments: [
        makeDocument(),
        makeDocument({ documentId: "9a1d0000-0000-4000-8000-000000000002", documentType: "MEDICAL", verificationStatus: "REVIEW_REQUIRED", ocrConfidence: 52.25 }),
    ],
    reviewQueue: {
        total: 17,
        pendingFiles: 14,
        reviewRequiredDocuments: 3,
        pendingByStatus: { MANUAL_REVIEW: 9, CONFLICT: 5 },
        items: [{ temporaryId: "tmp-1", documentType: "POLICE_SLIP", processingStatus: "MANUAL_REVIEW", receivedDate: "2026-09-25T03:00:00.000Z", client: CLIENT_REF }],
    },
};

export function documentList(items: DocumentItem[], { page = 1, pageSize = 25, total = items.length } = {}): DocumentList {
    return {
        items,
        pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
        summary: { total, byVerificationStatus: { VERIFIED: total - 1, REVIEW_REQUIRED: 1 } },
    };
}

export const CLIENT_DETAILS: ClientDetails = {
    client: {
        passportId: "N1234567", uniqueId: "0001", name: "KAMAL NIMAL PERERA", firstName: "KAMAL NIMAL", otherName: "PERERA",
        dateOfBirth: "1990-03-12T00:00:00.000Z", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11T00:00:00.000Z",
        whatsappNumber: "0770000000", contactNumber: null, address: null, job: null,
        createdDate: "2026-09-20T00:00:00.000Z", updatedDate: "2026-09-24T00:00:00.000Z",
    },
    documents: [
        makeDocument({ documentId: "aaaa0000-0000-4000-8000-000000000001", documentType: "PASSPORT", verificationStatus: "REVIEW_REQUIRED" }),
        makeDocument({ documentId: "bbbb0000-0000-4000-8000-000000000002", documentType: "POLICE_REPORT", verificationStatus: "VERIFIED" }),
    ],
    pendingItems: [{ temporaryId: "tmp-9", documentType: "UNKNOWN", processingStatus: "UNDEFINED", receivedDate: "2026-09-25T01:00:00.000Z", client: null }],
    requiredDocuments: [
        { documentType: "PASSPORT", status: "REVIEW_REQUIRED", storedCount: 1, pendingCount: 0 },
        { documentType: "POLICE_REPORT", status: "VERIFIED", storedCount: 1, pendingCount: 0 },
        { documentType: "MEDICAL", status: "MISSING", storedCount: 0, pendingCount: 0 },
    ],
    missingDocumentTypes: ["MEDICAL"],
    police: {
        latestSlip: null,
        latestReport: { documentId: "bbbb0000-0000-4000-8000-000000000002", receivedDate: "2026-09-24T07:05:03.000Z", verificationStatus: "VERIFIED" },
    },
};
