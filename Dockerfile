FROM oven/bun:1-alpine

# Chromium (Puppeteer용) + Node.js (MCP Server 실행) + GWS CLI
RUN apk add --no-cache \
    nodejs npm \
    chromium nss fontconfig font-noto-cjk \
    && npm install -g @googleworkspace/cli

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src/ ./src/

RUN addgroup -S app && adduser -S app -G app \
    && chown -R app:app /app \
    && mkdir -p /home/app/.config/gws \
    && chown -R app:app /home/app \
    && mkdir -p /app/data \
    && chown -R app:app /app/data
USER app

CMD ["bun", "run", "src/app.ts"]
