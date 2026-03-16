FROM oven/bun:1-alpine

# Node.js (npx fallback for LINE MCP Server) + GWS CLI (Google Workspace operations)
RUN apk add --no-cache nodejs npm \
    && npm install -g @googleworkspace/cli

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
