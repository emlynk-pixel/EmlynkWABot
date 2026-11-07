# Supabase email templates (invitation and password setup)

The emails are sent by Supabase Auth, so they are edited in the Supabase dashboard, not in this code.

| File | Supabase template | Used for |
|---|---|---|
| `invite-user.html` | Authentication > Email Templates > **Invite user** | The invitation (Invite User, Resend invitation) |
| `reset-password.html` | Authentication > Email Templates > **Reset Password** | "Forgot password", and the password-setup email a re-invite sends to someone who opened their invite link but never set a password |

## Steps
1. **Logo.** Email apps (Gmail, Outlook) do not show SVG images, so export `admin/src/assets/emops-on-dark.svg` as a **PNG** (about 340 px wide, transparent background; it is the light logo, made for the dark header) and put it at a public https address, for example the `admin/public` folder of the deployed app (`https://<your-app-domain>/admin/emops-logo.png`) or a public Supabase Storage bucket.
2. Open each file, replace `LOGO_URL` with that address, and keep `{{ .ConfirmationURL }}` exactly as written (Supabase fills it in).
3. In the dashboard open the template, paste the HTML into **Message body**, and set the **Subject** (given at the top of each file).
4. Send yourself a test: invite a test address, and use *Forgot password* on another.

## Good to know
- The invitation link lifetime is set under Authentication > Providers / Sessions (default 24 hours); the text in the invitation says 24 hours: change both together.
- Gmail and Outlook may add "images are blocked" until the reader allows them: the header is dark and the button is plain HTML, so the email still looks right without the logo.
- For emails to come from your own address (not Supabase's), set up custom SMTP under Project Settings > Authentication > SMTP Settings. Supabase's built-in sender is rate limited and meant for testing.
