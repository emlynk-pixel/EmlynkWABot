// Read-only audit of the application accounts (public."user") against Supabase Auth, to find the
// accounts hit by the old invitation bugs (Docs/SUPABASE_AUTH.md, "Invitation bugs fixed"). Run AFTER
// migration 20261110120000_user_activation_tracking. Never writes: a READ ONLY transaction (rolled
// back) and Supabase Admin list calls only. Prints account IDs, names, roles and statuses only:
// no email, token or password.
// Usage: node scripts/auditUserAccounts.js
import "dotenv/config";
import pg from "pg";

const { default: supabase } = await import("../src/config/supabase.js");

// Supabase identities by id: { emailConfirmedAt, lastSignInAt, invitedAt }.
async function supabaseIdentities() {
    const byId = new Map();
    for (let page = 1; page <= 50; page++) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw new Error(`Supabase Admin listUsers failed (${error.status ?? "?"})`);
        for (const user of data?.users ?? []) {
            byId.set(user.id, { emailConfirmedAt: user.email_confirmed_at ?? null, lastSignInAt: user.last_sign_in_at ?? null, invitedAt: user.invited_at ?? null });
        }
        if ((data?.users ?? []).length < 200) break;
    }
    return byId;
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query(`
        SELECT "admin_id", "auth_user_id", "name", "role", "status", "activated_at", "invited_at"
        FROM "user" ORDER BY "status", "admin_id"`);
    await client.query("ROLLBACK");
    const identities = await supabaseIdentities();

    const view = (row, extra = {}) => ({ adminId: row.admin_id, name: row.name, role: row.role, status: row.status, ...extra });
    const signedInAfterInvite = (row, identity) => identity?.lastSignInAt && (!row.invited_at || new Date(identity.lastSignInAt) > new Date(row.invited_at));

    const report = {
        totals: Object.fromEntries(["ACTIVE", "INVITED", "INACTIVE"].map((s) => [s, rows.filter((r) => r.status === s).length])),
        // BUG 1: ACTIVE without ever completing setup (made ACTIVE by a re-invite). They may have no
        // password. Fix: Deactivate, then Re-invite (they now get a password-setup email).
        activeNeverSetUp: rows.filter((r) => r.status === "ACTIVE" && !r.activated_at)
            .map((r) => view(r, { everSignedIn: Boolean(identities.get(r.auth_user_id)?.lastSignInAt) })),
        // BUG 2: still INVITED, but the identity signed in after the invitation (a password may have been
        // set without the activation). They become ACTIVE at their next password sign-in.
        invitedButSignedIn: rows.filter((r) => r.status === "INVITED" && signedInAfterInvite(r, identities.get(r.auth_user_id))).map((r) => view(r)),
        // BUG 2 (revoked): INACTIVE, never set up, but signed in after the invitation (a password set from
        // a revoked invitation's link). If they should have access: Re-invite.
        inactiveSignedInAfterRevokedInvite: rows.filter((r) => r.status === "INACTIVE" && !r.activated_at && signedInAfterInvite(r, identities.get(r.auth_user_id))).map((r) => view(r)),
        // Rows whose Supabase identity no longer exists (they can never sign in).
        missingSupabaseIdentity: rows.filter((r) => r.auth_user_id && !identities.has(r.auth_user_id)).map((r) => view(r)),
        // Pending invitations whose link has probably expired (older than 24 h): resend them.
        expiredInvitations: rows.filter((r) => r.status === "INVITED" && r.invited_at && Date.now() - new Date(r.invited_at).getTime() > 24 * 3600 * 1000).map((r) => view(r)),
    };
    console.log(JSON.stringify(report, null, 2));
} finally {
    await client.end();
}
