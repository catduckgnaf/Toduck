# Multi-stage build to compile Web UI and package standalone server
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Write the static HTML shell and fail the image if its scripts are missing.
RUN node scripts/capture-static-index.mjs

# Production runtime image
FROM golang:1.22-alpine AS go-builder
WORKDIR /src
COPY selfhost/go/go.mod selfhost/go/*.go ./
RUN CGO_ENABLED=0 go build -o /toduck-server .

FROM node:22-alpine AS runner

WORKDIR /app

# No explicit UID: the node base image already owns UID 1000 (user "node"),
# so `adduser -u 1000` fails with "uid '1000' in use".
RUN adduser -D toduck && mkdir -p /data /app/static && chown -R toduck:toduck /data /app

COPY --from=go-builder /toduck-server /app/toduck-server
COPY --from=builder /app/.vercel/output/static /app/static

USER toduck

ENV PORT=8787
ENV DATA_PATH=/data/state.json
ENV STATIC_DIR=/app/static

VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD /app/toduck-server --healthcheck http://127.0.0.1:8787/health

CMD ["/app/toduck-server"]
