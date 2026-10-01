# Backend (Express API, WhatsApp webhook, background submission worker)
# for Google Cloud Run. Build from the repository root:
#   docker build -t emlynk-backend .
#
# No build step: Node runs src/ directly. The Prisma client is generated
# into generated/prisma as TypeScript, which Node 22.18+ loads natively
# (src/config/runtime.js checks this at startup).
FROM node:22-bookworm-slim

# Prisma's query engine needs OpenSSL; CA certificates for HTTPS to
# Supabase, Meta and the OCR service.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# The schema must be present before `npm ci`: its postinstall runs
# `prisma generate`, which builds the Linux client and engine here.
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npm ci --omit=dev && npm cache clean --force

# Migrations, for `npx prisma migrate deploy` from this image (e.g. a Cloud
# Run Job); the server itself never runs them.
COPY prisma/migrations ./prisma/migrations
COPY src ./src
COPY scripts/createAdmin.js scripts/checkDatabaseConnection.js ./scripts/

# Cloud Run sets PORT (8080 by default); the server listens on all interfaces.
ENV PORT=8080
EXPOSE 8080

# The image's unprivileged user; the app writes nothing to disk.
USER node

# Node directly (not npm) so it receives SIGTERM from Cloud Run and runs the
# graceful shutdown in src/shutdown.js.
CMD ["node", "src/app.js"]
