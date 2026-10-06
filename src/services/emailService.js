// Email Service (Phase 12, Checkpoint 2).
//
// Handles invitation email dispatch with clean configuration placeholders
// for SMTP infrastructure (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
// EMAIL_FROM, ADMIN_SETUP_URL_BASE, APP_BASE_URL).
//
// When SMTP configuration is not present (or in development/testing mode),
// emails are held in-memory and logged safely without leaking sensitive tokens
// or external dependencies, providing a reliable local test and dev harness.

import nodemailer from "nodemailer";
import { isLoopbackUrl } from "./ocrClient.js";

const sentEmails = [];

/**
 * Returns a configured nodemailer SMTP transporter if SMTP credentials are present in env.
 */
export function getSmtpTransporter(env = process.env) {
    if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
        return nodemailer.createTransport({
            host: env.SMTP_HOST,
            port: Number(env.SMTP_PORT) || 587,
            secure: Number(env.SMTP_PORT) === 465,
            auth: {
                user: env.SMTP_USER,
                pass: String(env.SMTP_PASS).replace(/\s+/g, ""),
            },
        });
    }
    return null;
}

// The admin app is always served under this path: admin/vite.config.ts
// (base), admin/src/main.tsx (router basename) and vercel.json (rewrites).
export const ADMIN_BASE_PATH = "/admin";

// Development fallback: the Vite admin dev server.
const DEV_ADMIN_BASE_URL = "http://localhost:5173/admin";

// A missing or unusable base URL for emailed admin links. The message names
// the variable, never its value.
export class AdminLinkConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "AdminLinkConfigError";
    }
}

// A deployment (Vercel production/preview, or NODE_ENV=production), where a
// localhost link can't be opened by the recipient.
function isDeployed(env) {
    return env.NODE_ENV === "production" || (env.VERCEL === "1" && env.VERCEL_ENV !== "development");
}

/**
 * Returns the base URL of the admin frontend for emailed links, ending in
 * /admin exactly once. ADMIN_SETUP_URL_BASE wins over APP_BASE_URL; either
 * may be the site root or already end in /admin, with or without a trailing
 * slash. On a deployment a missing or localhost value throws
 * AdminLinkConfigError instead of producing a link nobody can open.
 */
export function getAdminBaseUrl(env = process.env) {
    const name = ["ADMIN_SETUP_URL_BASE", "APP_BASE_URL"].find((key) => typeof env[key] === "string" && env[key].trim() !== "");

    if (!name) {
        if (isDeployed(env)) {
            throw new AdminLinkConfigError("ADMIN_SETUP_URL_BASE (or APP_BASE_URL) must be set for this deployment");
        }
        return DEV_ADMIN_BASE_URL;
    }

    let url;
    try {
        url = new URL(env[name].trim());
    } catch {
        throw new AdminLinkConfigError(`${name} is not a valid URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new AdminLinkConfigError(`${name} must be an http(s) URL`);
    }
    if (isDeployed(env) && isLoopbackUrl(url.href)) {
        throw new AdminLinkConfigError(`${name} points to localhost; set it to this deployment's public URL`);
    }

    const path = url.pathname.replace(/\/+$/, "").replace(/\/admin$/i, "");
    return `${url.origin}${path}${ADMIN_BASE_PATH}`;
}

/**
 * Generates the full setup link containing the raw cryptographically secure token.
 */
export function getAdminSetupUrl(token, env = process.env) {
    const base = getAdminBaseUrl(env);
    return `${base}/setup-password?token=${encodeURIComponent(token)}`;
}

/**
 * Generates the full password reset link containing the raw cryptographically secure token.
 */
export function getAdminResetUrl(token, env = process.env) {
    const base = getAdminBaseUrl(env);
    return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * Returns a list of all sent emails recorded in memory (useful for testing and development).
 */
export function getSentEmails() {
    return [...sentEmails];
}

/**
 * Returns the most recently sent email from memory.
 */
export function getLastSentEmail() {
    return sentEmails.length > 0 ? sentEmails[sentEmails.length - 1] : null;
}

/**
 * Clears the in-memory sent email history.
 */
export function clearSentEmails() {
    sentEmails.length = 0;
}

/**
 * Dispatches an admin invitation email.
 *
 * @param {object} params
 * @param {string} params.email - Invitee email address
 * @param {string} params.name - Invitee name
 * @param {string} params.role - Assigned role ('ADMIN' | 'ANALYST' | 'VIEWER')
 * @param {string} params.token - Raw invitation token
 * @param {Date} params.expiresAt - Token expiration timestamp
 * @param {object} [params.transport] - Optional custom transport for test injection
 * @returns {Promise<{ success: boolean, mode: string, setupUrl: string }>}
 */
export async function sendInvitationEmail({ email, name, role, token, expiresAt, transport, env = process.env }) {
    const fromAddress = env.EMAIL_FROM || "no-reply@emlynk.local";
    const setupUrl = getAdminSetupUrl(token, env);
    const formattedExpiry = new Date(expiresAt).toUTCString();

    const subject = "You've been invited to Emlynk Admin Dashboard";

    const text = [
        `Hello ${name},`,
        "",
        `You have been invited to join the Emlynk WhatsApp Processing Admin Dashboard with the role of ${role}.`,
        "",
        `To set up your password and activate your account, please visit the following link:`,
        `${setupUrl}`,
        "",
        `Note: This invitation link is valid for 24 hours (expires ${formattedExpiry}) and can only be used once.`,
        "",
        "If you did not expect this invitation, please disregard this email.",
        "",
        "Regards,",
        "Emlynk Security Team",
    ].join("\n");

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; color: #0f172a; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 32px;">
    <h2 style="margin-top: 0; color: #0f172a; font-size: 20px;">Welcome to Emlynk Admin</h2>
    <p>Hello <strong>${escapeHtml(name)}</strong>,</p>
    <p>You have been invited to join the <strong>Emlynk WhatsApp Processing Admin Dashboard</strong> with the role of <strong>${escapeHtml(role)}</strong>.</p>
    <div style="margin: 28px 0;">
      <a href="${setupUrl}" style="background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 4px; font-weight: 500; display: inline-block;">Set Up Your Password</a>
    </div>
    <p style="font-size: 13px; color: #64748b;">Or copy and paste this link into your browser:<br>
      <a href="${setupUrl}" style="color: #2563eb; word-break: break-all;">${setupUrl}</a>
    </p>
    <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;">
    <p style="font-size: 12px; color: #64748b; margin-bottom: 0;">
      This invitation link expires in 24 hours (<strong>${formattedExpiry}</strong>) and is valid for a single use.<br>
      If you did not expect this invitation, please disregard this email.
    </p>
  </div>
</body>
</html>
    `.trim();

    const record = {
        to: email,
        from: fromAddress,
        subject,
        text,
        html,
        setupUrl,
        role,
        name,
        expiresAt,
        sentAt: new Date(),
    };

    if (transport && typeof transport.sendMail === "function") {
        await transport.sendMail(record);
        sentEmails.push(record);
        return { success: true, mode: "custom-transport", setupUrl };
    }

    const smtpTransporter = getSmtpTransporter(env);
    if (smtpTransporter) {
        await smtpTransporter.sendMail({
            from: fromAddress,
            to: email,
            subject,
            text,
            html,
        });
        sentEmails.push(record);
        return { success: true, mode: "smtp", setupUrl };
    }

    // Default development / test capture
    sentEmails.push(record);
    return { success: true, mode: "in-memory", setupUrl };
}

/**
 * Dispatches a password reset email.
 *
 * @param {object} params
 * @param {string} params.email - Admin email address
 * @param {string} [params.name] - Admin name
 * @param {string} params.token - Raw reset token
 * @param {Date} params.expiresAt - Expiration timestamp
 * @param {object} [params.transport] - Optional custom transport for test injection
 * @param {object} [params.env] - Environment variables
 * @returns {Promise<{ success: boolean, mode: string, resetUrl: string }>}
 */
export async function sendPasswordResetEmail({ email, name, token, expiresAt, transport, env = process.env }) {
    const fromAddress = env.EMAIL_FROM || "no-reply@emlynk.local";
    const resetUrl = getAdminResetUrl(token, env);
    const formattedExpiry = new Date(expiresAt).toUTCString();
    const displayName = name ? ` ${name}` : "";

    const subject = "Reset your Emlynk Admin password";

    const text = [
        `Hello${displayName},`,
        "",
        "We received a request to reset the password for your Emlynk Admin account.",
        "",
        "To choose a new password, please visit the following link:",
        `${resetUrl}`,
        "",
        `Note: This password reset link will expire in 1 hour (${formattedExpiry}) and can only be used once.`,
        "",
        "Security Warning: If you did not request a password reset, please ignore this email or contact your administrator immediately. Your password will not change until you access the link above and create a new one.",
        "",
        "Regards,",
        "Emlynk Security Team",
    ].join("\n");

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; color: #0f172a; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 32px;">
    <h2 style="margin-top: 0; color: #0f172a; font-size: 20px;">Reset Your Password</h2>
    <p>Hello${name ? ` <strong>${escapeHtml(name)}</strong>` : ""},</p>
    <p>We received a request to reset the password for your <strong>Emlynk Admin Console</strong> account.</p>
    <div style="margin: 28px 0;">
      <a href="${resetUrl}" style="background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 4px; font-weight: 500; display: inline-block;">Reset Password</a>
    </div>
    <p style="font-size: 13px; color: #64748b;">Or copy and paste this link into your browser:<br>
      <a href="${resetUrl}" style="color: #2563eb; word-break: break-all;">${resetUrl}</a>
    </p>
    <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;">
    <p style="font-size: 12px; color: #64748b; margin-bottom: 0;">
      This password reset link expires in 1 hour (<strong>${formattedExpiry}</strong>) and is valid for a single use.<br>
      <strong>Security Notice:</strong> If you did not request this password reset, please disregard this email or report it to your administrator immediately. Your password will not change without using this link.
    </p>
  </div>
</body>
</html>
    `.trim();

    const record = {
        to: email,
        from: fromAddress,
        subject,
        text,
        html,
        resetUrl,
        name: name ?? null,
        expiresAt,
        sentAt: new Date(),
    };

    if (transport && typeof transport.sendMail === "function") {
        await transport.sendMail(record);
        sentEmails.push(record);
        return { success: true, mode: "custom-transport", resetUrl };
    }

    const smtpTransporter = getSmtpTransporter(env);
    if (smtpTransporter) {
        await smtpTransporter.sendMail({
            from: fromAddress,
            to: email,
            subject,
            text,
            html,
        });
        sentEmails.push(record);
        return { success: true, mode: "smtp", resetUrl };
    }

    sentEmails.push(record);
    return { success: true, mode: "in-memory", resetUrl };
}

function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
