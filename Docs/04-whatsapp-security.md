# WhatsApp Webhook Security

## Overview

The Emlynk WhatsApp Document Processing backend uses the official WhatsApp Business API and webhook architecture.

The webhook security layer ensures that incoming webhook requests are genuine requests sent by Meta and not unauthorized requests sent directly to the backend.

## Webhook Verification

Meta verifies the webhook endpoint using:

- `hub.mode`
- `hub.verify_token`
- `hub.challenge`

The backend compares the received verify token with the value stored in the environment variables.

```env
WHATSAPP_VERIFY_TOKEN=your_verify_token
```

If the token is valid, the backend returns the challenge value to Meta.

## Webhook Signature Verification

Webhook GET verification alone is not sufficient to secure incoming POST requests.

Meta sends the `X-Hub-Signature-256` HTTP header with webhook POST requests.

The backend verifies this signature using the Meta App Secret.

```env
META_APP_SECRET=your_meta_app_secret
```

The raw HTTP request body is preserved before Express converts the request body to JSON.

The backend generates an HMAC SHA-256 signature using the raw webhook body and Meta App Secret, then securely compares the generated signature with the signature received from Meta.

If the signatures do not match, the webhook request is rejected.

## Signature Verification Flow

```text
Meta
  ↓
POST /whatsapp/webhook
  ↓
X-Hub-Signature-256 received
  ↓
Raw request body preserved
  ↓
HMAC SHA-256 generated using App Secret
  ↓
Signatures compared
  ↓
Valid → Continue processing
Invalid → Reject request
```

## Access Token Security

The WhatsApp Access Token is used when the backend communicates with the Meta Graph API.

Examples:

- Getting a media download URL
- Downloading WhatsApp documents

The Access Token is stored only in the `.env` file.

```env
WHATSAPP_ACCESS_TOKEN=your_access_token
```

Secrets are not committed to GitHub, and `.env` is included in `.gitignore`.

## Security Files

### `src/middleware/verifyWhatsappSignature.js`

Responsible for:

- Reading the Meta signature
- Checking the App Secret
- Calculating the expected signature
- Securely comparing signatures
- Rejecting invalid webhook requests

### `src/app.js`

Preserves the raw request body before JSON parsing so webhook signatures can be verified.

### `src/routes/whatsapp.js`

Uses the signature verification middleware before processing incoming WhatsApp events.

## Additional Protection

The project includes basic WhatsApp message idempotency protection.

Each WhatsApp message contains a unique message ID. The backend uses this ID to prevent the same webhook event from being processed multiple times during the current server session.

Persistent database-backed idempotency can be added during later processing stages.

## Current Security Status

Implemented:

- Webhook verification token
- Meta webhook signature verification
- HMAC SHA-256 validation
- Environment-based secret management
- WhatsApp Access Token protection
- Basic duplicate message protection
- No sensitive environment values committed to Git

Future improvements:

- Persistent idempotency
- Production secret management
- Request monitoring
- Rate limiting where required
- Production logging and security auditing
