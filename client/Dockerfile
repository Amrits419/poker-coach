# ── Build stage ──────────────────────────────────────────────────────────
FROM node:24-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD wget -qO- http://127.0.0.1:80/ || exit 1
