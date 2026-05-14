FROM node:22-alpine

ARG USE_SYSTEM_FFMPEG=true

RUN if [ "$USE_SYSTEM_FFMPEG" = "true" ]; then apk add --no-cache ffmpeg; fi

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV USE_SYSTEM_FFMPEG=${USE_SYSTEM_FFMPEG}
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
