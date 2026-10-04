// CSRF protection (double-submit cookie pattern) for cookie-authenticated
// mutating requests. CodeQL (js/missing-csrf-middleware): this app relies on
// the admin auth cookie being httpOnly + SameSite=Strict (see auth.js) as its
// primary CSRF defence, which the scanner doesn't model as a mitigation.
// This adds an explicit, recognised CSRF-token check as defence in depth
// (SameSite alone doesn't protect same-site/subdomain scenarios or a future
// SameSite downgrade).
//
// Only cookie-authenticated requests carry CSRF risk: a request authenticated
// via `Authorization: Bearer` (CLI tools, tests, and anything without an
// ambient browser cookie) can't be forged cross-site — a page on another
// origin can't attach a custom header without CORS permission this app
// doesn't grant. Those requests are exempt (skipCsrfProtection) rather than
// requiring every non-browser caller to also carry a CSRF token.
import { doubleCsrf } from "csrf-csrf";
import { AUTH_COOKIE_NAME, isSecureContext } from "./auth.js";

const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
    getSecret: () => process.env.JWT_SECRET,
    // Binds each token to the specific signed-in session (its JWT cookie
    // value), so a token obtained for one session can't be replayed once
    // that session ends (logout) or a different admin signs in.
    getSessionIdentifier: (req) => req.cookies?.[AUTH_COOKIE_NAME] ?? "no-session",
    cookieName: "emlynk_csrf",
    cookieOptions: {
        sameSite: "strict",
        httpOnly: true,
        secure: isSecureContext(),
    },
    skipCsrfProtection: (req) => !req.cookies?.[AUTH_COOKIE_NAME] || Boolean(req.headers.authorization),
});

export { generateCsrfToken, doubleCsrfProtection };
