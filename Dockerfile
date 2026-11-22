FROM python:3.12-slim AS onnxruntime

RUN pip install --no-cache-dir --target=/ort onnxruntime==1.31.0

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
    libgomp1 \
    $(if [ "$USE_SYSTEM_FFMPEG" = "true" ]; then echo "ffmpeg"; fi) \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/edge-image /app/edge-image
COPY public /app/public

COPY --from=onnxruntime /ort/onnxruntime/capi/ /opt/onnxruntime/

RUN mkdir -p /data

ENV PORT=3000
ENV PLATFORM=huggingface
ENV PUBLIC_DIR=/app/public
ENV GOMEMLIMIT=10GiB
ENV ONNXRUNTIME_LIB_PATH=/opt/onnxruntime/libonnxruntime.so.1.31.0
ENV LD_LIBRARY_PATH=/opt/onnxruntime
ENV NSFW_MODEL_PATH=/data/models/nsfw_detection_2_mini.onnx

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/healthz || exit 1

ENTRYPOINT ["/app/edge-image"]
