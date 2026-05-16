# ── Stage 1: install deps & prune ──
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    rm -rf node_modules/ffmpeg-static \
           node_modules/ffprobe-static \
           node_modules/@vercel

# ── Stage 2: production image ──
FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV USE_SYSTEM_FFMPEG=true
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFPROBE_PATH=/usr/bin/ffprobe
ENV PORT=3000
ENV PLATFORM=huggingface

EXPOSE 3000

CMD ["node", "server.js"]
