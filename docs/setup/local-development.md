# Local Development

This guide walks through setting up a local development environment for `sanalabo-automation`.

For Docker-based or production deployment, see [docs/deployment/](../deployment/).

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| [Bun](https://bun.sh/) v1.0+ | JavaScript runtime |
| [ngrok](https://ngrok.com/) | Tunnel for LINE Webhook — free account with static domain |
| LINE Messaging API channel | Create via [LINE Developers Console](https://developers.line.biz/) |
| [Anthropic API key](https://console.anthropic.com/) | Claude model access |
| Google Cloud OAuth 2.0 credentials | **Optional** — required only for Gmail / Calendar / Drive features |

---

## Setup Overview

1. Clone & install
2. Set up an ngrok static domain
3. Configure the LINE Bot channel
4. Configure Google OAuth *(optional)*
5. Set environment variables
6. Start the server
7. Capture your LINE user ID

---

## 1. Clone & Install

```bash
git clone https://github.com/sanalabo-org/sanalabo-automation.git
cd sanalabo-automation
bun install
```

---

## 2. Set Up ngrok Static Domain

A **static domain** persists across ngrok restarts, so you never need to update the LINE Webhook URL again.

1. Sign up at [ngrok.com](https://ngrok.com/)
2. Go to **Dashboard → Domains → New Domain** — a free static domain is generated automatically (format: `<random-name>.ngrok-free.app`)
3. Install the CLI and register your auth token:

```bash
# macOS
brew install ngrok

# Register your auth token (Dashboard → Your Authtoken)
ngrok config add-authtoken <AUTHTOKEN>
```

---

## 3. Configure the LINE Bot

1. Open the [LINE Developers Console](https://developers.line.biz/) → select your channel → **Messaging API** tab
2. Set the **Webhook URL**:
   ```
   https://<your-static-domain>.ngrok-free.app/webhook/line
   ```
3. Enable **Use webhook**
4. Click **Verify** once the server is running to confirm connectivity

Copy the following values into your `.env`:

| Field | `.env` variable |
|-------|----------------|
| Channel access token (long-lived) | `LINE_CHANNEL_ACCESS_TOKEN` |
| Channel secret | `LINE_CHANNEL_SECRET` |

---

## 4. Configure Google OAuth *(optional — GWS features only)*

Skip this step if you do not need Gmail, Calendar, or Drive features.

### ① Enable APIs

In [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Library**, enable:

- Gmail API
- Google Calendar API
- Google Drive API

### ② Create OAuth 2.0 credentials

1. **APIs & Services → OAuth consent screen** — set app name, support email, and add the required scopes. Add your Google account as a test user.
2. **Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URIs:
     ```
     https://<your-static-domain>.ngrok-free.app/auth/google/callback
     ```
3. Copy the **Client ID** and **Client Secret**

### ③ Generate an encryption key

Token storage uses AES-256-GCM encryption. Generate a 32-byte master key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 5. Set Environment Variables

```bash
cp .env.example .env
```

Open `.env` and fill in the required values:

```dotenv
# Required
ANTHROPIC_API_KEY=sk-ant-...
LINE_CHANNEL_ACCESS_TOKEN=...
LINE_CHANNEL_SECRET=...
SYSTEM_ADMIN_IDS=U...              # Your LINE userId (see Step 7)

# GWS features only (optional)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://<your-static-domain>.ngrok-free.app/auth/google/callback
TOKEN_ENCRYPTION_KEY=...           # 64-char hex string from Step 4③
```

For the full list of variables, see [Environment Variables](./environment-variables.md).

---

## 6. Start the Server

**Terminal 1** — app server:

```bash
bun run dev
```

**Terminal 2** — ngrok tunnel:

```bash
ngrok http --domain=<your-static-domain>.ngrok-free.app 3000
```

Verify the server is running:

```bash
curl http://localhost:3000/health
```

---

## 7. Capture Your LINE User ID

You need your LINE `userId` to set `SYSTEM_ADMIN_IDS`:

1. Add `LOG_LEVEL=debug` to `.env`
2. Restart `bun run dev`
3. Send any message to your LINE Bot
4. Find the `userId` in the server logs:
   ```
   { userId: "Uxxxxxxxxxx...", eventType: "message", ... }
   ```
5. Set `SYSTEM_ADMIN_IDS` in `.env` to that value and restart the server
6. Remove `LOG_LEVEL=debug` once confirmed

---

## Next Steps

- [Testing](../testing.md) — unit tests plus local and test-server smoke tests
- [Environment Variables](./environment-variables.md) — full variable reference
- [Deployment](../deployment/) — Docker Compose and production setup
