FROM golang:1.25-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=1 GOOS=linux go build -o /app/edge-image ./cmd/server

FROM debian:bookworm-slim

ARG USE_SYSTEM_FFMPEG=true

RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips42 \
    ca-certificates \
    curl \
    $(if [ "$USE_SYSTEM_FFMPEG" = "true" ]; then echo "ffmpeg"; fi) \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/edge-image /app/edge-image
COPY public /app/public

RUN mkdir -p /data
VOLUME /data

ENV PORT=3000
ENV PLATFORM=huggingface
ENV PUBLIC_DIR=/app/public
ENV GOMEMLIMIT=10GiB

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/healthz || exit 1

ENTRYPOINT ["/app/edge-image"]
