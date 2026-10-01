# OCR service for Google Cloud Run. Build from this directory:
#   docker build -t emlynk-ocr-worker .
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only. @tesseract.js-data/eng brings the English
# model (eng.traineddata.gz) into the image, so no instance downloads it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Cloud Run sends traffic to $PORT (8080) on all interfaces; IAM guards it.
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080

# The image's unprivileged user; the app writes nothing to disk.
USER node

CMD ["node", "src/server.js"]
