// Settings > Candidate Form: the public form's title, logo and colours. A REAL PostgreSQL
// (PGlite, every migration) through the real Prisma client and the real routers. Synthetic data only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { contrastRatio, DEFAULT_FORM_BRANDING, MAX_LOGO_BYTES, parseBrandingBody } from "../src/services/candidateFormBrandingService.js";

const ORIGIN = "https://candidate-form.example.test";
const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2) };

const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64")}`;
const svg = (markup) => `data:image/svg+xml;base64,${Buffer.from(markup).toString("base64")}`;
const VALID = () => ({ formTitle: "Recruitment Form", colors: { light: { ...DEFAULT_FORM_BRANDING.colors.light }, dark: { ...DEFAULT_FORM_BRANDING.colors.dark } } });

describe("parseBrandingBody", () => {
    const field = (body) => parseBrandingBody(body).errors?.map((e) => e.field) ?? [];

    test("accepts the defaults, trims the title and lowercases colours", () => {
        const body = VALID();
        body.formTitle = "  Recruitment Form  ";
        body.colors.light.accent = "#E7000B";
        const { values } = parseBrandingBody(body);
        assert.equal(values.formTitle, "Recruitment Form");
        assert.equal(values.colors.light.accent, "#e7000b");
        assert.equal("logo" in values, false, "an absent logo means keep the current one");
        assert.equal("showLogo" in values, false, "an absent showLogo means keep the current choice");
    });

    test("showLogo: true or false is accepted, anything else is refused", () => {
        assert.equal(parseBrandingBody({ ...VALID(), showLogo: false }).values.showLogo, false);
        assert.equal(parseBrandingBody({ ...VALID(), showLogo: true }).values.showLogo, true);
        for (const showLogo of ["false", 0, null, "no"]) assert.deepEqual(field({ ...VALID(), showLogo }), ["showLogo"]);
    });

    test("the defaults pass the same readability checks every custom theme must pass", () => {
        assert.deepEqual(parseBrandingBody(VALID()).errors, undefined);
    });

    test("refuses a missing, long, or multi-line title", () => {
        for (const formTitle of ["", "   ", "x".repeat(81), "two\nlines", undefined, 7]) assert.deepEqual(field({ ...VALID(), formTitle }), ["formTitle"]);
    });

    test("a title is plain text: markup is stored as typed and escaped when shown", () => {
        assert.equal(parseBrandingBody({ ...VALID(), formTitle: "<b>Form</b>" }).values.formTitle, "<b>Form</b>");
    });

    test("refuses anything that is not #rrggbb, so nothing else reaches a stylesheet", () => {
        for (const accent of ["red", "#fff", "#e7000b;}", "url(x)", "", null]) {
            const body = VALID();
            body.colors.light.accent = accent;
            assert.deepEqual(field(body), ["colors.light.accent"]);
        }
    });

    test("refuses colours that would leave text unreadable, in either theme", () => {
        const darkOnLight = VALID();
        darkOnLight.colors.light.surface = "#333333";
        assert.deepEqual(field(darkOnLight), ["colors.light.surface"]);
        const lightOnDark = VALID();
        lightOnDark.colors.dark.background = "#f5f5f5";
        assert.deepEqual(field(lightOnDark), ["colors.dark.background"]);
    });

    test("refuses an accent that disappears into the surface", () => {
        const body = VALID();
        body.colors.dark.accent = "#262c34";
        assert.deepEqual(field(body), ["colors.dark.accent"]);
    });

    test("logo: accepts each allowed type whose bytes match, and null to remove", () => {
        assert.equal(parseBrandingBody({ ...VALID(), logo: PNG }).values.logo, PNG);
        assert.equal(parseBrandingBody({ ...VALID(), logo: `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64")}` }).errors, undefined);
        assert.equal(parseBrandingBody({ ...VALID(), logo: svg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>') }).errors, undefined);
        assert.equal(parseBrandingBody({ ...VALID(), logo: null }).values.logo, null);
    });

    test("logo: refuses a wrong type, bytes that don't match it, or an oversized file", () => {
        const bad = [
            "https://example.test/logo.png",
            "data:text/html;base64,PHNjcmlwdD4=",
            `data:image/gif;base64,${Buffer.from("GIF89a").toString("base64")}`,
            `data:image/png;base64,${Buffer.from("not a png").toString("base64")}`,
            `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_LOGO_BYTES)]).toString("base64")}`,
            42,
        ];
        for (const logo of bad) assert.deepEqual(field({ ...VALID(), logo }), ["logo"]);
    });

    test("logo: refuses an SVG with active content", () => {
        for (const markup of ['<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"/>', '<svg><a href="https://example.test"/></svg>', "<svg><foreignObject/></svg>"]) {
            assert.deepEqual(field({ ...VALID(), logo: svg(markup) }), ["logo"]);
        }
    });

    test("refuses unknown fields", () => {
        assert.deepEqual(field({ ...VALID(), logoUrl: "x" }), ["logoUrl"]);
    });

    test("contrastRatio matches the WCAG formula", () => {
        assert.equal(Number(contrastRatio("#ffffff", "#e7000b").toFixed(2)), 4.77);
    });
});

describe("branding API", () => {
    let database;
    let prisma;
    let pg;
    let server;
    let base;

    before(async () => {
        database = await createTestDatabase();
        ({ prisma, pg } = database);
        for (const u of Object.values(USERS)) await prisma.user.create({ data: u });

        const app = express();
        const requireAdmin = (req, res, next) => {
            req.user = USERS[req.get("x-test-user")];
            return req.user ? next() : res.status(401).json({ message: "Unauthorized" });
        };
        app.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit, candidateFormOrigin: ORIGIN }));
        app.use(PUBLIC_CANDIDATE_DETAILS_PATH, createPublicCandidateDetailsRouter({ db: prisma, allowedOrigin: ORIGIN, brandingLimiter: noRateLimit, verifyIpLimiter: noRateLimit, verifyPassportLimiter: noRateLimit, log: { error() {}, log() {} } }));
        app.use(errorHandler);
        server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(async () => {
        await new Promise((resolve) => server.close(resolve));
        await database?.close();
    });
    beforeEach(async () => {
        await pg.exec(`
            ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
            DELETE FROM "candidate_form_branding";
        `);
    });

    const admin = (method, body, as = "ADMIN") => fetch(`${base}/api/admin/settings/form-branding`, {
        method,
        headers: { "Content-Type": "application/json", "x-test-user": as },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const publicBranding = (origin = ORIGIN) => fetch(`${base}${PUBLIC_CANDIDATE_DETAILS_PATH}/branding`, { method: "POST", headers: { Origin: origin } });

    test("the table is closed to Supabase's public roles, like every other table", async () => {
        const { rows: [table] } = await pg.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'candidate_form_branding'`);
        assert.equal(table.relrowsecurity, true);
    });

    test("the table can only ever hold one row", async () => {
        await assert.rejects(pg.exec(`INSERT INTO "candidate_form_branding" ("id", "form_title", "colors") VALUES ('second', 'x', '{}')`));
    });

    test("with nothing saved, both sides get the defaults", async () => {
        const body = await (await publicBranding()).json();
        assert.deepEqual({ ...body }, { formTitle: "Candidate Form", colors: DEFAULT_FORM_BRANDING.colors, logo: null, showLogo: true, custom: false });
        const saved = await (await admin("GET")).json();
        assert.equal(saved.custom, false);
        assert.equal(saved.showLogo, true);
    });

    test("an ADMIN saves; the public form receives it; the audit records no logo bytes", async () => {
        const response = await admin("PUT", { ...VALID(), logo: PNG });
        assert.equal(response.status, 200);
        const body = await (await publicBranding()).json();
        assert.equal(body.formTitle, "Recruitment Form");
        assert.equal(body.logo, PNG);
        assert.equal(body.custom, true);
        assert.equal("updatedAt" in body, false, "the public view says nothing about who or when");

        const [entry] = await prisma.auditLog.findMany({ where: { action: "UPDATE_FORM_BRANDING" } });
        assert.equal(entry.adminId, USERS.ADMIN.adminId);
        assert.equal(JSON.parse(entry.newValue).logo, "CHANGED");
        assert.equal(entry.newValue.includes("base64"), false);
    });

    test("leaving the logo out keeps it; null removes it", async () => {
        await admin("PUT", { ...VALID(), logo: PNG });
        await admin("PUT", { ...VALID(), formTitle: "Second" });
        let body = await (await publicBranding()).json();
        assert.deepEqual([body.formTitle, body.logo], ["Second", PNG]);
        await admin("PUT", { ...VALID(), logo: null });
        body = await (await publicBranding()).json();
        assert.equal(body.logo, null);
    });

    test("showLogo: false hides the logo for the form and keeps the uploaded one; leaving it out keeps the choice", async () => {
        await admin("PUT", { ...VALID(), logo: PNG });
        assert.equal((await (await publicBranding()).json()).showLogo, true, "a saved logo shows unless it is hidden");

        assert.equal((await admin("PUT", { ...VALID(), showLogo: false })).status, 200);
        let body = await (await publicBranding()).json();
        assert.deepEqual([body.showLogo, body.logo], [false, PNG], "hiding the logo does not delete the upload");

        await admin("PUT", { ...VALID(), formTitle: "Third" });
        body = await (await publicBranding()).json();
        assert.deepEqual([body.formTitle, body.showLogo], ["Third", false], "a save that doesn't mention it keeps it hidden");
        assert.equal((await (await admin("GET")).json()).showLogo, false);

        await admin("PUT", { ...VALID(), showLogo: true });
        assert.equal((await (await publicBranding()).json()).showLogo, true);
    });

    test("showLogo is kept with the colours and never comes back as one", async () => {
        await admin("PUT", { ...VALID(), showLogo: false });
        const row = await prisma.candidateFormBranding.findUnique({ where: { id: "default" } });
        assert.equal(row.colors.showLogo, false);
        for (const body of [await (await publicBranding()).json(), await (await admin("GET")).json()]) {
            assert.deepEqual(Object.keys(body.colors).sort(), ["dark", "light"]);
            assert.equal(body.showLogo, false);
        }
    });

    test("a row saved before showLogo existed keeps its colours and shows the logo", async () => {
        await prisma.candidateFormBranding.create({ data: { id: "default", formTitle: "Older", colors: VALID().colors } });
        const body = await (await publicBranding()).json();
        assert.deepEqual([body.formTitle, body.showLogo], ["Older", true]);
        assert.deepEqual(body.colors, VALID().colors);
    });

    test("the audit entry records whether the logo was shown", async () => {
        await admin("PUT", { ...VALID(), showLogo: false });
        const [entry] = await prisma.auditLog.findMany({ where: { action: "UPDATE_FORM_BRANDING" } });
        assert.equal(JSON.parse(entry.newValue).showLogo, false);
    });

    test("a refused save changes nothing and says which field", async () => {
        await admin("PUT", VALID());
        const body = VALID();
        body.colors.light.surface = "#000000";
        const response = await admin("PUT", body);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).errors[0].field, "colors.light.surface");
        assert.equal((await (await publicBranding()).json()).colors.light.surface, "#ffffff");
    });

    test("only an ADMIN can read or change it", async () => {
        assert.equal((await admin("GET", undefined, "MANAGER")).status, 403);
        assert.equal((await admin("PUT", VALID(), "MANAGER")).status, 403);
        assert.equal((await admin("GET", undefined, "NOBODY")).status, 401);
    });

    test("the public route keeps the form's CORS rule: its own origin only, and POST only", async () => {
        assert.equal((await publicBranding("https://evil.example.test")).status, 403);
        const ok = await publicBranding();
        assert.equal(ok.headers.get("access-control-allow-methods"), "POST, OPTIONS");
        assert.equal(ok.headers.get("cache-control"), "no-store");
    });

    test("if the database fails, the form still gets the defaults", async () => {
        const app = express();
        const broken = { candidateFormBranding: { findUnique: async () => { throw new Error("down"); } } };
        app.use("/x", createPublicCandidateDetailsRouter({ db: broken, allowedOrigin: ORIGIN, brandingLimiter: noRateLimit, verifyIpLimiter: noRateLimit, verifyPassportLimiter: noRateLimit, log: { error() {}, log() {} } }));
        const local = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
        try {
            const response = await fetch(`http://127.0.0.1:${local.address().port}/x/branding`, { method: "POST" });
            assert.equal(response.status, 200);
            assert.equal((await response.json()).custom, false);
        } finally {
            await new Promise((resolve) => local.close(resolve));
        }
    });
});
