// Candidate Extra Details public form, Task 1: POST
// /api/public/candidate-details/verify, the candidate token, CORS, the public
// rate limits, and the separation from the staff routes. On a REAL PostgreSQL
// (PGlite, every migration applied) through the real Prisma client and the
// real createApp wiring. Synthetic candidates only; no Supabase, no network.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createApp } from "../src/createApp.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createAuthRouter } from "../src/routes/auth.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { createRequireActiveUser } from "../src/middleware/requireActiveUser.js";
import { createRequireCandidateFormToken } from "../src/middleware/requireCandidateFormToken.js";
import { createAccessTokenVerifier, looksLikeAccessToken } from "../src/auth/supabaseIdentity.js";
import { issueCandidateFormToken, readCandidateFormToken, CANDIDATE_FORM_TOKEN_TTL_MS } from "../src/services/candidateFormTokenService.js";
import { VERIFY_FAILED_MESSAGE } from "../src/services/candidateFormVerificationService.js";
import { findEnvProblems } from "../src/config/env.js";
import { buildMetaContentSecurityPolicy, HEADER_CONTENT_SECURITY_POLICY } from "../candidate-form/csp.ts";

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const VERIFY = `${PUBLIC_CANDIDATE_DETAILS_PATH}/verify`;
const silentLog = { warn() {}, error() {}, info() {}, log() {} };

// A: stored with "+"; B: stored without "+"; C: legacy lower-case passport, local Sri Lankan number.
const A = { passportId: "N1000001", uniqueId: "9001", firstName: "Alpha", otherName: "Person", whatsappNumber: "+94771111111", nic: "900000001V", address: "1 Alpha Road" };
const B = { passportId: "N2000002", uniqueId: "9002", firstName: "Beta", otherName: "Person", whatsappNumber: "94772222222", nic: "900000002V", address: "2 Beta Road" };
const C = { passportId: "ab123456", uniqueId: "9003", firstName: "Gamma", otherName: "Person", whatsappNumber: "0773333333", nic: "900000003V" };
// D1/D2: legacy case variants of one passport (ambiguous for any other casing).
const D1 = { passportId: "cd123456", uniqueId: "9004", firstName: "Delta", otherName: "One", whatsappNumber: "+94774444444" };
const D2 = { passportId: "CD123456", uniqueId: "9005", firstName: "Delta", otherName: "Two", whatsappNumber: "+94775555555" };

let database;
let prisma;
let pg;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    await prisma.candidate.createMany({ data: [A, B, C, D1, D2] });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`DELETE FROM "rate_limits";`);
    await prisma.candidate.update({ where: { passportId: A.passportId }, data: { whatsappNumber: A.whatsappNumber } });
});

// Counts every candidate-table query, to prove rejected input never reaches the database.
function countingDb() {
    const counter = { calls: 0 };
    const db = new Proxy(prisma, {
        get(target, prop) {
            if (prop !== "candidate") return target[prop];
            return new Proxy(target.candidate, {
                get(model, method) {
                    const fn = model[method];
                    return typeof fn === "function" ? (...args) => { counter.calls += 1; return fn.apply(model, args); } : fn;
                },
            });
        },
    });
    return { db, counter };
}

// The public router as createApp would build it, with the limiters replaceable.
const publicRouter = (overrides = {}) => createPublicCandidateDetailsRouter({
    db: prisma,
    tokenSecret: SECRET,
    allowedOrigin: ORIGIN,
    verifyIpLimiter: noRateLimit,
    verifyPassportLimiter: noRateLimit,
    log: silentLog,
    ...overrides,
});

// The whole app (createApp) with real staff middleware in front of /api/admin
// and /auth, and a stub Supabase client that counts verification calls.
function buildApp({ router = publicRouter() } = {}) {
    const supabase = { calls: 0 };
    const client = { auth: { getUser: async () => { supabase.calls += 1; return { data: { user: null }, error: { status: 401, name: "AuthApiError" } }; } } };
    const verifyAccessToken = createAccessTokenVerifier({ client });
    const app = createApp({
        adminDistDir: path.join(path.dirname(fileURLToPath(import.meta.url)), "no-admin-dist-for-this-test"),
        authRouter: createAuthRouter({ db: prisma, verifyAccessToken, apiLimiter: noRateLimit }),
        adminApiRouter: createAdminRouter({ db: prisma, bucket: {}, requireAdmin: createRequireActiveUser({ db: prisma, verifyAccessToken }), apiLimiter: noRateLimit }),
        adminFrontendLimiter: noRateLimit,
        publicCandidateRouter: router,
    });
    return { app, supabase };
}

async function withServer(app, run) {
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        return await run((p, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${p}`, init));
    } finally {
        server.close();
    }
}

// Polls `check` until it is true (at most ~3 s).
async function waitFor(check) {
    for (let i = 0; i < 150; i += 1) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("condition not reached");
}

const jsonPost = (body, headers = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const readJson = async (res) => ({ status: res.status, body: await res.json().catch(() => null), headers: res.headers });

async function verify(body, { app = buildApp().app, headers } = {}) {
    return withServer(app, async (call) => readJson(await call(VERIFY, jsonPost(body, headers))));
}

describe("VERIFY: Passport + WhatsApp verification", () => {
    test("VERIFY-001 a valid Passport + WhatsApp of one candidate returns a token and its expiry only", async () => {
        const { status, body } = await verify({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber });
        assert.equal(status, 200);
        assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "token"]);
        assert.ok(body.token.startsWith("cf1~"));
    });

    test("VERIFY-001b stored-number variants and a legacy lower-case passport verify; spaces and hyphens in the passport are ignored", async () => {
        assert.equal((await verify({ passportNumber: B.passportId, whatsappNumber: "+94772222222" })).status, 200, "stored without +");
        assert.equal((await verify({ passportNumber: "AB123456", whatsappNumber: "+94773333333" })).status, 200, "legacy lower-case passport, local stored number");
        assert.equal((await verify({ passportNumber: " N10-000 01 ", whatsappNumber: ` ${A.whatsappNumber} ` })).status, 200, "trimmed, spaces and hyphens ignored");
    });

    test("VERIFY-002/003/004 wrong passport, wrong WhatsApp, or A's passport with B's WhatsApp: one identical generic 401", async () => {
        const cases = [
            { passportNumber: "N9999999", whatsappNumber: A.whatsappNumber },
            { passportNumber: A.passportId, whatsappNumber: "+94779999999" },
            { passportNumber: A.passportId, whatsappNumber: "+94772222222" },
            { passportNumber: "N9999999", whatsappNumber: "+94779999999" },
        ];
        const results = [];
        for (const body of cases) results.push(await verify(body));
        for (const r of results) {
            assert.equal(r.status, 401);
            assert.deepEqual(r.body, { message: VERIFY_FAILED_MESSAGE, code: "VERIFICATION_FAILED" });
        }
    });

    test("VERIFY-005 missing or extra fields are a 400 that never echoes values", async () => {
        for (const body of [{}, { passportNumber: A.passportId }, { whatsappNumber: A.whatsappNumber }, { passportNumber: "", whatsappNumber: "" }, [], "null"]) {
            const r = await verify(body);
            assert.equal(r.status, 400, JSON.stringify(body));
        }
        const extra = await verify({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber, passportId: "N2000002" });
        assert.equal(extra.status, 400, "an unexpected field is refused, not ignored");
        assert.ok(!JSON.stringify(extra.body).includes("N2000002"));
    });

    test("VERIFY-006/007/009 wildcard and SQL-like passports are rejected before any database query", async () => {
        const { db, counter } = countingDb();
        const app = buildApp({ router: publicRouter({ db }) }).app;
        const before = await prisma.candidate.count();
        for (const passportNumber of ["%", "N100000%", "N1%", "_", "N100000_", "A_123456", "' OR '1'='1", "N1000001'; DROP TABLE candidate;--", "N1000001\"", "N1000001*", "N10000011234567890123"]) {
            const r = await verify({ passportNumber, whatsappNumber: A.whatsappNumber }, { app });
            assert.equal(r.status, 400, passportNumber);
            assert.ok(!JSON.stringify(r.body).includes(passportNumber.slice(0, 6)) || passportNumber.length < 3, "input not echoed");
        }
        assert.equal(counter.calls, 0, "no candidate query was made");
        assert.equal(await prisma.candidate.count(), before);
    });

    test("VERIFY-008 malformed WhatsApp numbers are rejected before any database query", async () => {
        const { db, counter } = countingDb();
        const app = buildApp({ router: publicRouter({ db }) }).app;
        for (const whatsappNumber of ["94771111111", "0771111111", "+0771111111", "+94 77 111 1111", "+94-771111111", "+1234567", "+1234567890123456", "+94771111111' OR 1=1", "%4567"]) {
            assert.equal((await verify({ passportNumber: A.passportId, whatsappNumber }, { app })).status, 400, whatsappNumber);
        }
        assert.equal(counter.calls, 0);
    });

    test("VERIFY-008b '+771111111' (9 digits) is not treated as a Sri Lankan local number", async () => {
        // normalizePhoneNumber would expand 7XXXXXXXX to 947XXXXXXXX; the public input is compared as given.
        const r = await verify({ passportNumber: A.passportId, whatsappNumber: "+771111111" });
        assert.equal(r.status, 401);
    });

    test("VERIFY-010 the success response carries no candidate data, and the token does not reveal it", async () => {
        const { body } = await verify({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber });
        const text = JSON.stringify(body);
        for (const value of [A.passportId, "771111111", A.firstName, A.otherName, A.nic, A.address, A.uniqueId]) {
            assert.ok(!text.includes(value), `response must not contain ${value}`);
        }
        const decodedParts = body.token.split("~").slice(1).map((part) => Buffer.from(part, "base64url").toString("latin1")).join(" ");
        assert.ok(!decodedParts.includes(A.passportId), "the token is encrypted: the passport ID is not readable");
    });

    test("verification fails closed (503) without a usable token secret", async () => {
        const app = buildApp({ router: publicRouter({ tokenSecret: "too-short" }) }).app;
        const r = await verify({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber }, { app });
        assert.equal(r.status, 503);
        assert.equal(r.body.token, undefined);
    });

    test("public body limit (16 KB), unknown public paths and responses are not cached", async () => {
        await withServer(buildApp().app, async (call) => {
            const big = await call(VERIFY, jsonPost({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber, pad: "x".repeat(17 * 1024) }));
            assert.equal(big.status, 413);
            const bad = await readJson(await call(VERIFY, jsonPost("{not json")));
            assert.equal(bad.status, 400);
            assert.ok(!/stack|SyntaxError|at /.test(JSON.stringify(bad.body)));
            const unknown = await call(`${PUBLIC_CANDIDATE_DETAILS_PATH}/${A.passportId}`);
            assert.equal(unknown.status, 404);
            const getVerify = await call(VERIFY);
            assert.equal(getVerify.status, 404, "verify is POST only");
            const ok = await call(VERIFY, jsonPost({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber }));
            assert.equal(ok.headers.get("cache-control"), "no-store");
        });
    });
});

describe("TOKEN: short-lived candidate token", () => {
    const issue = (now = new Date()) => issueCandidateFormToken({ secret: SECRET, passportId: A.passportId, whatsappDigits: "94771111111", now });

    test("TOKEN-001 a valid token identifies one candidate for 15 minutes and is not JWT-shaped", async () => {
        const now = new Date("2026-10-15T08:00:00Z");
        const { token, expiresAt } = issue(now);
        const payload = readCandidateFormToken(token, { secret: SECRET, now });
        assert.equal(payload.sub, A.passportId);
        assert.equal(payload.exp - payload.iat, CANDIDATE_FORM_TOKEN_TTL_MS / 1000);
        assert.equal(expiresAt, "2026-10-15T08:15:00.000Z");
        assert.equal(looksLikeAccessToken(token), false, "the staff verifier rejects it by shape");
    });

    test("TOKEN-002 a modified, re-signed or foreign token is rejected", async () => {
        const { token } = issue();
        const [prefix, iv, sealed] = token.split("~");
        const flip = (s, i) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
        const variants = [
            `${prefix}~${flip(iv, 2)}~${sealed}`,
            `${prefix}~${iv}~${flip(sealed, 5)}`,
            `${prefix}~${iv}~${flip(sealed, sealed.length - 3)}`,
            `cf2~${iv}~${sealed}`,
            `${prefix}.${iv}.${sealed}`,
            `${token}~extra`,
            "",
            "x".repeat(2000),
        ];
        for (const value of variants) assert.equal(readCandidateFormToken(value, { secret: SECRET }), null, value.slice(0, 20));
        assert.equal(readCandidateFormToken(token, { secret: `${SECRET}-other` }), null, "another secret");
    });

    test("TOKEN-003 an expired token is rejected", async () => {
        const issuedAt = new Date("2026-10-15T08:00:00Z");
        const { token } = issue(issuedAt);
        assert.ok(readCandidateFormToken(token, { secret: SECRET, now: new Date("2026-10-15T08:14:59Z") }));
        assert.equal(readCandidateFormToken(token, { secret: SECRET, now: new Date("2026-10-15T08:15:00Z") }), null);
        assert.equal(readCandidateFormToken(token, { secret: SECRET, now: new Date("2026-10-15T09:00:00Z") }), null);
    });

    test("TOKEN-004 a candidate token is rejected by /api/admin/* and /auth/* without any Supabase call", async () => {
        const { body } = await verify({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber });
        const { app, supabase } = buildApp();
        await withServer(app, async (call) => {
            const auth = { Authorization: `Bearer ${body.token}` };
            const probes = [
                ["GET", "/api/admin/candidates"], ["GET", `/api/admin/candidates/${A.passportId}`], ["GET", `/api/admin/candidates/${A.passportId}/additional-details`],
                ["PUT", `/api/admin/candidates/${A.passportId}/additional-details`], ["GET", "/api/admin/documents"], ["GET", "/api/admin/review"],
                ["GET", "/api/admin/work-allocation/candidates"], ["POST", "/api/admin/work-allocation/assign"], ["GET", "/api/admin/audit-logs"],
                ["GET", "/api/admin/users"], ["GET", "/api/admin/settings/sheet-sync/status"], ["GET", "/api/admin/overview"], ["GET", "/auth/me"],
            ];
            for (const [method, p] of probes) {
                const res = await call(p, { method, headers: { ...auth, "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
                assert.equal(res.status, 401, `${method} ${p}`);
                const text = await res.text();
                assert.ok(!text.includes(A.firstName) && !/stack|prisma/i.test(text), `${method} ${p} leaks nothing`);
            }
        });
        assert.equal(supabase.calls, 0, "the token never reached the Supabase staff verifier");
    });

    test("TOKEN-005 the token middleware accepts a valid token and rejects it once the stored WhatsApp changes", async () => {
        const { body } = await verify({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber });
        const guard = createRequireCandidateFormToken({ db: prisma, secret: SECRET });
        const run = async (headers, query = {}) => {
            let status = 200; let identity = null;
            const req = { headers, query, params: {}, body: {} };
            const res = { status(code) { status = code; return this; }, json() { return this; } };
            await guard(req, res, () => { identity = req.candidateForm; });
            return { status, identity };
        };
        const ok = await run({ authorization: `Bearer ${body.token}` });
        assert.deepEqual([ok.status, ok.identity?.passportId], [200, A.passportId]);
        // Identity comes from the token only: a passport in the query is never read.
        const withQuery = await run({ authorization: `Bearer ${body.token}` }, { passportId: B.passportId });
        assert.equal(withQuery.identity.passportId, A.passportId);
        assert.equal((await run({})).status, 401, "no token");
        assert.equal((await run({ authorization: body.token })).status, 401, "not a Bearer header");

        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { whatsappNumber: "+94770000001" } });
        assert.equal((await run({ authorization: `Bearer ${body.token}` })).status, 401, "binding no longer matches");
    });
});

describe("CORS: exact Candidate Form origin only", () => {
    test("CORS-001 the configured origin gets a preflight and a CORS grant without credentials", async () => {
        await withServer(buildApp().app, async (call) => {
            const pre = await call(VERIFY, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
            assert.equal(pre.status, 204);
            assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
            assert.equal(pre.headers.get("access-control-allow-methods"), "POST, OPTIONS");
            assert.equal(pre.headers.get("access-control-allow-headers"), "Content-Type, Authorization");
            assert.equal(pre.headers.get("access-control-allow-credentials"), null);
            const post = await call(VERIFY, jsonPost({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber }, { Origin: ORIGIN }));
            assert.equal(post.status, 200);
            assert.equal(post.headers.get("access-control-allow-origin"), ORIGIN);
            assert.match(post.headers.get("vary") ?? "", /Origin/);
        });
    });

    test("CORS-002 any other origin gets 403 and no CORS grant; admin routes never grant CORS", async () => {
        await withServer(buildApp().app, async (call) => {
            for (const origin of ["https://evil.example", `${ORIGIN}.evil.example`, "http://candidate-form.example.test", "null"]) {
                const pre = await call(VERIFY, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
                assert.equal(pre.status, 403, origin);
                assert.equal(pre.headers.get("access-control-allow-origin"), null, origin);
                const post = await call(VERIFY, jsonPost({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber }, { Origin: origin }));
                assert.equal(post.status, 403, origin);
                assert.equal(post.headers.get("access-control-allow-origin"), null);
            }
            const admin = await call("/api/admin/candidates", { headers: { Origin: ORIGIN } });
            assert.equal(admin.status, 401);
            assert.equal(admin.headers.get("access-control-allow-origin"), null, "no CORS on staff routes");
        });
        // No origin configured: no browser origin is allowed.
        await withServer(buildApp({ router: publicRouter({ allowedOrigin: undefined }) }).app, async (call) => {
            const post = await call(VERIFY, jsonPost({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber }, { Origin: ORIGIN }));
            assert.equal(post.status, 403);
        });
    });

    test("CORS is not authorization: a request without an Origin is still fully checked", async () => {
        const r = await verify({ passportNumber: A.passportId, whatsappNumber: "+94779999999" });
        assert.equal(r.status, 401);
    });
});

describe("RATE: public verification limits (PostgreSQL store)", () => {
    test("RATE-001 failed attempts per IP and per passport are limited; successes do not count; keys hold no raw passport", async () => {
        const router = createPublicCandidateDetailsRouter({
            db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, log: silentLog,
            limits: { perIp: { windowMs: 15 * 60 * 1000, limit: 3 }, perPassport: { windowMs: 60 * 60 * 1000, limit: 100 } },
        });
        const app = buildApp({ router }).app;
        await withServer(app, async (call) => {
            const send = async (body) => (await call(VERIFY, jsonPost(body))).status;
            // Successes are taken off again (the decrement runs after the response; wait for it).
            for (let i = 0; i < 4; i += 1) assert.equal(await send({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber }), 200);
            await waitFor(async () => (await prisma.rateLimit.findMany({ where: { key: { startsWith: "public-verify-ip:" } } })).every((row) => row.hits === 0));
            // Three failures (bad input counts too), then the IP is limited, even for a correct request.
            assert.equal(await send({ passportNumber: "%", whatsappNumber: A.whatsappNumber }), 400);
            assert.equal(await send({ passportNumber: A.passportId, whatsappNumber: "+94779999999" }), 401);
            assert.equal(await send({ passportNumber: "N9999999", whatsappNumber: A.whatsappNumber }), 401);
            assert.equal(await send({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber }), 429);
        });

        await pg.exec(`DELETE FROM "rate_limits";`);
        const perPassport = createPublicCandidateDetailsRouter({
            db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, log: silentLog,
            limits: { perIp: { windowMs: 15 * 60 * 1000, limit: 100 }, perPassport: { windowMs: 60 * 60 * 1000, limit: 2 } },
        });
        await withServer(buildApp({ router: perPassport }).app, async (call) => {
            const send = async (body) => readJson(await call(VERIFY, jsonPost(body)));
            assert.equal((await send({ passportNumber: A.passportId, whatsappNumber: "+94779999991" })).status, 401);
            assert.equal((await send({ passportNumber: "n1000001", whatsappNumber: "+94779999992" })).status, 401, "case variants share the limit");
            const locked = await send({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber });
            assert.equal(locked.status, 429, "this passport is now locked, even with the right number");
            assert.equal(locked.body.token, undefined);
            assert.equal((await send({ passportNumber: B.passportId, whatsappNumber: "+94772222222" })).status, 200, "another passport is unaffected");
        });
        const keys = (await prisma.rateLimit.findMany({ select: { key: true } })).map((row) => row.key);
        assert.ok(keys.length > 0);
        assert.ok(keys.every((key) => key.startsWith("public-verify-") && !key.includes(A.passportId) && !key.toUpperCase().includes(A.passportId)));
    });
});

describe("SECRET: candidate-form holds no backend configuration", () => {
    const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "candidate-form");
    const FORBIDDEN = /DATABASE_URL|DIRECT_URL|SUPABASE|SERVICE_ROLE|CANDIDATE_FORM_TOKEN_SECRET|META_APP_SECRET|WHATSAPP_ACCESS_TOKEN|WHATSAPP_VERIFY_TOKEN|GOOGLE_APPLICATION|SHEET_SPREADSHEET|SHEET_SYNC/;
    const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === "node_modules") return [];
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? files(full) : [full];
    });

    test("SECRET-001 sources, configuration and any built bundle contain no backend secret names; only VITE_API_BASE_URL is read", async () => {
        const all = files(ROOT).filter((file) => !file.endsWith("package-lock.json"));
        assert.ok(all.some((file) => file.endsWith("vite.config.ts")));
        for (const file of all) {
            const text = fs.readFileSync(file, "utf8");
            assert.ok(!FORBIDDEN.test(text), `${path.relative(ROOT, file)} mentions a backend secret`);
        }
        const envReads = all.filter((f) => /\.(ts|tsx)$/.test(f)).flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/import\.meta\.env\.([A-Z_]+)/g)].map((m) => m[1]));
        assert.deepEqual([...new Set(envReads)], ["VITE_API_BASE_URL"]);
        const vite = fs.readFileSync(path.join(ROOT, "vite.config.ts"), "utf8");
        assert.match(vite, /const ENV_PREFIX = "VITE_API_"/);
        assert.match(vite, /envPrefix: ENV_PREFIX/);
        assert.match(vite, /sourcemap: false/);
        // Either line ending: a Windows checkout (core.autocrlf) has CRLF.
        const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8").split(/\r?\n/).filter((line) => /^[A-Z]/.test(line));
        assert.deepEqual(example, ["VITE_API_BASE_URL="]);
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
        assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((name) => /supabase|prisma|pg$|googleapis/.test(name)), "no database / Supabase / Google client in the form");
        const dist = path.join(ROOT, "dist");
        if (fs.existsSync(dist)) assert.ok(!files(dist).some((file) => file.endsWith(".map")), "no source maps in the build");
    });
});

describe("Configuration checks", () => {
    test("CANDIDATE_FORM_ORIGIN and CANDIDATE_FORM_TOKEN_SECRET are validated only when set", () => {
        const base = {};
        const problems = (env) => findEnvProblems(env, { required: [] });
        assert.deepEqual(problems(base), []);
        assert.deepEqual(problems({ CANDIDATE_FORM_ORIGIN: ORIGIN, CANDIDATE_FORM_TOKEN_SECRET: SECRET }), []);
        assert.deepEqual(problems({ CANDIDATE_FORM_ORIGIN: "http://localhost:5174" }), []);
        for (const bad of ["http://candidate-form.example.test", `${ORIGIN}/form`, "*", "https://user:pw@x.example", "not a url"]) {
            assert.equal(problems({ CANDIDATE_FORM_ORIGIN: bad }).length, 1, bad);
        }
        assert.equal(problems({ CANDIDATE_FORM_TOKEN_SECRET: "short" }).length, 1);
    });
});

// Records every candidate-table operation (method + query arguments), so the
// work done for different failing inputs can be compared.
function recordingDb() {
    const calls = [];
    const db = new Proxy(prisma, {
        get(target, prop) {
            if (prop !== "candidate") return target[prop];
            return new Proxy(target.candidate, {
                get(model, method) {
                    const fn = model[method];
                    return typeof fn === "function" ? (...args) => { calls.push({ method, args }); return fn.apply(model, args); } : fn;
                },
            });
        },
    });
    return { db, calls };
}

// Same shape of query; only the submitted passport value may differ.
const querySkeleton = (calls) => calls.map(({ method, args }) => JSON.stringify({ method, args: JSON.parse(JSON.stringify(args).replace(/"equals":"[A-Za-z0-9]+"/g, "\"equals\":\"?\"")) }));

describe("TIMING: failing verifications do the same work and look the same", () => {
    const FAILURES = {
        nonexistentPassport: { passportNumber: "N9999999", whatsappNumber: A.whatsappNumber },
        wrongWhatsapp: { passportNumber: A.passportId, whatsappNumber: "+94779999999" },
        ambiguousCaseVariants: { passportNumber: "Cd123456", whatsappNumber: D1.whatsappNumber },
    };

    test("TIMING-001 nonexistent passport, wrong WhatsApp and ambiguous case variants give identical status, body and headers", async () => {
        const results = {};
        for (const [name, body] of Object.entries(FAILURES)) results[name] = await verify(body);
        const reference = results.nonexistentPassport;
        for (const [name, r] of Object.entries(results)) {
            assert.equal(r.status, 401, name);
            assert.deepEqual(r.body, { message: VERIFY_FAILED_MESSAGE, code: "VERIFICATION_FAILED" }, name);
            assert.equal(r.headers.get("content-length"), reference.headers.get("content-length"), name);
            assert.equal(r.headers.get("cache-control"), reference.headers.get("cache-control"), name);
        }
        // The exact-case variants still verify, so ambiguity is the only reason for the failure above.
        assert.equal((await verify({ passportNumber: D1.passportId, whatsappNumber: D1.whatsappNumber })).status, 200);
        assert.equal((await verify({ passportNumber: D2.passportId, whatsappNumber: D2.whatsappNumber })).status, 200);
    });

    test("TIMING-002 every failing path runs the same single candidate query (same method, filter shape, columns and limit)", async () => {
        const skeletons = {};
        for (const [name, body] of Object.entries(FAILURES)) {
            const { db, calls } = recordingDb();
            const r = await verify(body, { app: buildApp({ router: publicRouter({ db }) }).app });
            assert.equal(r.status, 401, name);
            assert.equal(calls.length, 1, `${name}: exactly one candidate query`);
            assert.equal(calls[0].method, "findMany", name);
            skeletons[name] = querySkeleton(calls);
        }
        assert.deepEqual(skeletons.wrongWhatsapp, skeletons.nonexistentPassport);
        assert.deepEqual(skeletons.ambiguousCaseVariants, skeletons.nonexistentPassport);
        // A successful verification runs the same query too (no extra lookup on the success path).
        const { db, calls } = recordingDb();
        assert.equal((await verify({ passportNumber: A.passportId, whatsappNumber: A.whatsappNumber }, { app: buildApp({ router: publicRouter({ db }) }).app })).status, 200);
        assert.deepEqual(querySkeleton(calls), skeletons.nonexistentPassport);
    });

    test("TIMING-003 failure responses carry no candidate data and the query reads only passport and WhatsApp columns", async () => {
        const { db, calls } = recordingDb();
        const app = buildApp({ router: publicRouter({ db }) }).app;
        for (const body of Object.values(FAILURES)) {
            const r = await verify(body, { app });
            const text = JSON.stringify(r.body);
            for (const candidate of [A, B, C, D1, D2]) {
                for (const value of [candidate.passportId, candidate.firstName, candidate.otherName, candidate.whatsappNumber, candidate.whatsappNumber.replace("+", ""), candidate.nic, candidate.address].filter(Boolean)) {
                    assert.ok(!text.toUpperCase().includes(value.toUpperCase()), `failure body leaks ${value}`);
                }
            }
        }
        for (const { args } of calls) assert.deepEqual(args[0].select, { passportId: true, whatsappNumber: true });
    });
});

describe("CSP: the API boundary is the exact configured origin", () => {
    const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "candidate-form");
    const API = "https://api.example.test";
    const directives = (policy) => new Map(policy.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name, values];
    }));

    test("CSP-001 the meta policy allows only the configured API origin for connections, with no https: or * anywhere", () => {
        const policy = directives(buildMetaContentSecurityPolicy(API));
        assert.deepEqual(policy.get("connect-src"), [API]);
        assert.deepEqual(directives(buildMetaContentSecurityPolicy(`${API}/`)).get("connect-src"), [API]);
        assert.deepEqual(directives(buildMetaContentSecurityPolicy("")).get("connect-src"), ["'self'"], "same-origin API");
        assert.deepEqual(policy.get("default-src"), ["'self'"]);
        for (const [name, values] of policy) {
            assert.ok(!values.includes("https:") && !values.includes("http:"), `${name} allows a whole scheme`);
            assert.ok(!values.some((value) => value.includes("*")), `${name} has a wildcard`);
        }
        for (const bad of ["http://api.example.test", `${API}/api`, `${API}?x=1`, "https://user:pw@api.example.test", "*", "https:", "not a url"]) {
            assert.throws(() => buildMetaContentSecurityPolicy(bad), /VITE_API_BASE_URL/, bad);
        }
    });

    test("CSP-002 the vercel.json header policy equals the shared header policy and cannot widen connections", () => {
        const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
        const values = vercel.headers.flatMap((rule) => rule.headers).filter((h) => h.key.toLowerCase() === "content-security-policy").map((h) => h.value);
        assert.deepEqual(values, [HEADER_CONTENT_SECURITY_POLICY], "exactly one CSP header, the shared value");
        const policy = directives(HEADER_CONTENT_SECURITY_POLICY);
        for (const fetchDirective of ["connect-src", "default-src", "script-src"]) assert.ok(!policy.has(fetchDirective), `header must not define ${fetchDirective}`);
        assert.deepEqual(policy.get("frame-ancestors"), ["'none'"]);
        assert.ok(!/https:|\*/.test(HEADER_CONTENT_SECURITY_POLICY));
    });

    test("CSP-003 a built index.html (when present) carries the meta policy with connect-src set to one exact origin", () => {
        const built = path.join(ROOT, "dist", "index.html");
        if (!fs.existsSync(built)) return;
        const html = fs.readFileSync(built, "utf8");
        const metas = [...html.matchAll(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"/gi)].map((m) => m[1].replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&"));
        assert.equal(metas.length, 1);
        const connect = directives(metas[0]).get("connect-src");
        assert.equal(connect.length, 1);
        assert.ok(connect[0] === "'self'" || /^https:\/\/[^/*\s]+$|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(connect[0]), connect[0]);
        assert.ok(!/(^|\s)https:(\s|;|$)|\*/.test(metas[0]));
        assert.equal(metas[0], buildMetaContentSecurityPolicy(connect[0] === "'self'" ? "" : connect[0]));
    });
});
