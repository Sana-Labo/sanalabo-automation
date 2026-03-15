FROM oven/bun:1-alpine

# Node.js: fallback for npx when bunx cannot run the LINE MCP Server
RUN apk add --no-cache nodejs npm

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src/ ./src/

RUN addgroup -S app && adduser -S app -G app \
    && chown -R app:app /app \
    && mkdir -p /home/app/.config/gws \
    && chown -R app:app /home/app
USER app

CMD ["bun", "run", "src/app.ts"]
