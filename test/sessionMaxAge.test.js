// Maximum session age (src/auth/supabaseIdentity.js): every session is refused
// 30 days after its sign-in (the latest amr timestamp), however often it is
// refreshed. Stand-in Supabase client: nothing here contacts Supabase.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { MAX_SESSION_AGE_MS, createAccessTokenVerifier, looksLikeAccessToken, signedInAt } from "../src/auth/supabaseIdentity.js";

const USER_ID = "7d0c2f0e-1111-4222-8333-444455556666";
const DAY_MS = 24 * 60 * 60 * 1000;
// A fixed "sign-in" moment (whole seconds, as amr timestamps are).
const SIGNED_IN_S = 1_790_000_000;
const SIGNED_IN_MS = SIGNED_IN_S * 1000;

const tokenWith = (claims) => `eyJhbGciOiJFUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: "x", ...claims })).toString("base64url")}.c2lnbmF0dXJl`;
const signedInToken = (timestamp = SIGNED_IN_S, method = "password") => tokenWith({ amr: [{ method, timestamp }] });

function fakeClient(answer = { data: { user: { id: USER_ID, email: "p@example.invalid" } }, error: null }) {
    const calls = [];
    return {
        calls,
        auth: {
            async getUser(token) {
                calls.push(token);
                return typeof answer === "function" ? answer(token) : answer;
            },
        },
    };
}

const verifierAt = (nowMs, client = fakeClient()) => createAccessTokenVerifier({ client, now: () => nowMs });

describe("MAX_SESSION_AGE_MS and signedInAt", () => {
    test("the cap is 30 days", () => {
        assert.equal(MAX_SESSION_AGE_MS, 30 * DAY_MS);
    });

    test("sign-in time is the latest amr timestamp, in ms", () => {
        assert.equal(signedInAt(signedInToken()), SIGNED_IN_MS);
        const token = tokenWith({ amr: [{ method: "password", timestamp: SIGNED_IN_S - 100 }, { method: "recovery", timestamp: SIGNED_IN_S }, { method: "otp", timestamp: SIGNED_IN_S - 5 }] });
        assert.equal(signedInAt(token), SIGNED_IN_MS);
    });

    test("no amr timestamp -> null", () => {
        for (const claims of [{}, { amr: [] }, { amr: "password" }, { amr: ["password"] }, { amr: [{ method: "password" }] }, { amr: [{ method: "password", timestamp: "1790000000" }] }]) {
            assert.equal(signedInAt(tokenWith(claims)), null, JSON.stringify(claims));
        }
        assert.equal(signedInAt("not.a-json.payload"), null);
    });
});

describe("createAccessTokenVerifier: maximum session age", () => {
    test("a fresh sign-in is accepted", async () => {
        const identity = await verifierAt(SIGNED_IN_MS)(signedInToken());
        assert.deepEqual(identity, { authUserId: USER_ID, email: "p@example.invalid", amr: ["password"] });
    });

    test("29 days after sign-in is accepted; exactly 30 days is the last accepted moment", async () => {
        assert.equal((await verifierAt(SIGNED_IN_MS + 29 * DAY_MS)(signedInToken())).authUserId, USER_ID);
        assert.equal((await verifierAt(SIGNED_IN_MS + 30 * DAY_MS)(signedInToken())).authUserId, USER_ID);
    });

    test("30 days + 1 ms after sign-in -> null (401, the admin app signs out)", async () => {
        assert.equal(await verifierAt(SIGNED_IN_MS + 30 * DAY_MS + 1)(signedInToken()), null);
    });

    test("defaults to Date.now and MAX_SESSION_AGE_MS", async () => {
        const verify = createAccessTokenVerifier({ client: fakeClient() });
        assert.equal((await verify(signedInToken(Math.floor(Date.now() / 1000)))).authUserId, USER_ID);
        assert.equal(await verify(signedInToken(Math.floor((Date.now() - 31 * DAY_MS) / 1000))), null);
    });

    test("maxSessionAgeMs is injectable", async () => {
        const verify = createAccessTokenVerifier({ client: fakeClient(), now: () => SIGNED_IN_MS + 2000, maxSessionAgeMs: 1000 });
        assert.equal(await verify(signedInToken()), null);
    });

    test("the latest of several amr timestamps is used (a re-authentication starts a new 30 days)", async () => {
        const token = tokenWith({ amr: [{ method: "password", timestamp: SIGNED_IN_S - 40 * 86400 }, { method: "recovery", timestamp: SIGNED_IN_S }] });
        const identity = await verifierAt(SIGNED_IN_MS + 29 * DAY_MS)(token);
        assert.deepEqual(identity.amr, ["password", "recovery"], "amr output unchanged");
        assert.equal(await verifierAt(SIGNED_IN_MS + 30 * DAY_MS + 1)(token), null);
    });

    test("missing amr, or amr without timestamps -> null (fails closed)", async () => {
        const verify = verifierAt(SIGNED_IN_MS);
        for (const claims of [{}, { amr: [] }, { amr: null }, { amr: [{ method: "password" }] }, { amr: [{ method: "password", timestamp: null }] }]) {
            const token = tokenWith(claims);
            assert.equal(looksLikeAccessToken(token), true);
            assert.equal(await verify(token), null, JSON.stringify(claims));
        }
    });

    test("a second factor or refresh never restarts the 30 days: password 31 days ago + totp now -> null", async () => {
        const now = SIGNED_IN_MS + 31 * DAY_MS;
        const nowS = now / 1000;
        for (const method of ["totp", "phone", "webauthn", "mfa/totp", "mfa/phone", "token_refresh"]) {
            const token = tokenWith({ amr: [{ method: "password", timestamp: SIGNED_IN_S }, { method, timestamp: nowS }] });
            assert.equal(signedInAt(token), SIGNED_IN_MS, method);
            assert.equal(await verifierAt(now)(token), null, method);
        }
    });

    test("password now + totp -> accepted; amr output unchanged", async () => {
        const token = tokenWith({ amr: [{ method: "totp", timestamp: SIGNED_IN_S }, { method: "password", timestamp: SIGNED_IN_S - 60 }] });
        const identity = await verifierAt(SIGNED_IN_MS)(token);
        assert.equal(identity.authUserId, USER_ID);
        assert.deepEqual(identity.amr, ["totp", "password"]);
    });

    test("only second-factor / refresh entries (no sign-in method) -> null (fails closed)", async () => {
        const token = tokenWith({ amr: [{ method: "totp", timestamp: SIGNED_IN_S }, { method: "mfa/webauthn", timestamp: SIGNED_IN_S }, { method: "token_refresh", timestamp: SIGNED_IN_S }] });
        assert.equal(signedInAt(token), null);
        assert.equal(await verifierAt(SIGNED_IN_MS)(token), null);
        assert.equal(signedInAt(tokenWith({ amr: [{ timestamp: SIGNED_IN_S }] })), null, "an entry with no method is not a sign-in");
    });

    test("string-form amr entries (no timestamp) -> null", async () => {
        assert.equal(await verifierAt(SIGNED_IN_MS)(tokenWith({ amr: ["password", "otp"] })), null);
    });

    test("a token Supabase refuses is still null, even when freshly signed in", async () => {
        for (const error of [{ status: 401, name: "AuthApiError" }, { status: 403, code: "session_not_found" }, { name: "AuthSessionMissingError" }]) {
            const client = fakeClient({ data: { user: null }, error });
            assert.equal(await verifierAt(SIGNED_IN_MS, client)(signedInToken()), null, JSON.stringify(error));
            assert.equal(client.calls.length, 1, "Supabase is still asked first");
        }
    });

    test("a Supabase outage still throws (fails closed), whatever the session age", async () => {
        const failing = fakeClient({ data: { user: null }, error: { status: 500 } });
        await assert.rejects(verifierAt(SIGNED_IN_MS, failing)(signedInToken()), (error) => error.name === "AuthVerificationError");
        await assert.rejects(verifierAt(SIGNED_IN_MS + 31 * DAY_MS, failing)(signedInToken()), (error) => error.name === "AuthVerificationError");
        const network = fakeClient(() => Promise.reject(new TypeError("fetch failed")));
        await assert.rejects(verifierAt(SIGNED_IN_MS, network)(tokenWith({})), /fetch failed/);
    });
});
