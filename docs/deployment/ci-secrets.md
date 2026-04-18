# CI/CD Secrets & Environments

How GitHub Actions obtains the credentials it needs to deploy to the home server. Covers the `dev` environment (PR 3) and forward-references `prod` (PR 4) and shared secrets (PR 5).

**Design reference:** [docs/design/phase4-cicd.md §5.3](../design/phase4-cicd.md#53-secret-management)
**Runner setup:** [docs/deployment/runner.md](./runner.md)

---

## 1. Why GitHub Environments

Each deploy target (`dev`, `prod`) is a GitHub **Environment** — not a repo-level secret. This gives us three properties we need:

| Property | Where it matters |
|----------|------------------|
| **Secret isolation per environment** | `DEV_ENV_FILE` never reachable from a `prod` workflow, and vice versa |
| **Approval gates** | `prod` can require a reviewer; `dev` does not (PR 4) |
| **Deployment history** | Each run is visible on the repo's Environments page — "last deployed SHA", "who approved" |

The workflow opts in via `environment: dev` on the job.

---

## 2. One-time setup — `dev` environment

### 2.1 Create the environment

1. <https://github.com/Sana-Labo/sanalabo-automation/settings/environments>
2. **New environment** → name: **`dev`** (lowercase, exact match with `environment: dev` in the workflow)
3. **Deployment branches**: select **"Selected branches and tags"** → add rule `develop` (only `develop` pushes can target `dev`)
4. **Protection rules**: leave unset — dev deploys without approval. `prod` will add a required reviewer in PR 4.
5. Save.

### 2.2 Register individual environment secrets

Each sensitive variable is stored as its **own** environment secret, not as one monolithic blob. This is the standard GitHub Actions pattern: secrets are rotated, audited, and log-masked independently.

The `dev` environment requires these secrets (all required — workflow fails fast if any is missing):

| Secret name | Source | Notes |
|-------------|--------|-------|
| `ANTHROPIC_API_KEY` | <https://console.anthropic.com/> → API Keys | Use a **dev-specific** key (separate billing from prod) |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers Console → dev channel → Messaging API | Dev channel only — not the production bot |
| `LINE_CHANNEL_SECRET` | LINE Developers Console → dev channel → Basic settings | Same dev channel |
| `SYSTEM_ADMIN_IDS` | Your LINE userId(s) for testing | Comma-separated (e.g., `Uabc123,Udef456`). Whitespace-free |
| `GOOGLE_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials → dev OAuth client | Full value ending in `.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Same OAuth client | |
| `GOOGLE_REDIRECT_URI` | `https://<dev 공개 도메인>/auth/google/callback` | Must match the OAuth client's Authorized redirect URI exactly |
| `TOKEN_ENCRYPTION_KEY` | Generate locally — see below | **32-byte random** value; never reuse prod's |

`TOKEN_ENCRYPTION_KEY` generation (run locally, paste output into the secret):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Constraints that apply to all secrets:

- **No surrounding whitespace or quotes** — paste the raw value (GitHub does not strip for you).
- **LF only, no BOM** — applies even to single-line values some editors accidentally append CRLF.
- Rotating dev's `TOKEN_ENCRYPTION_KEY` invalidates all encrypted OAuth tokens under `data/workspaces/` (dev users must re-authorize).

`CF_TUNNEL_TOKEN` is intentionally absent — Phase 4 PR 4 moves the Cloudflare tunnel to a shared `_shared/cloudflared/` compose file, so the dev app container no longer runs its own tunnel.

### 2.3 Upload each secret

For each row in §2.2:

1. <https://github.com/Sana-Labo/sanalabo-automation/settings/environments/dev/edit>
2. **Environment secrets → Add secret**
3. Paste the **exact name** from the table (case-sensitive)
4. Paste the value
5. **Add secret**

Alternatively via `gh` (requires `repo` PAT; Claude's sandbox blocks `gh`, so you run this):

```bash
gh secret set ANTHROPIC_API_KEY --env dev --body "$VALUE"
# ... repeat for each secret
```

Verify: the environment's secrets list shows all eight entries with timestamps.

> **Why environment-level, not repo-level?** A repo secret is reachable from any branch's workflow. Environment secrets only resolve when a job declares `environment: dev`, and the environment's deployment-branches rule further restricts which branches can claim that environment. `prod` will reuse the same split (PR 4) with its own reviewer gate.

---

## 3. How the workflow consumes the secrets

`.github/workflows/deploy-dev.yml` exposes each secret as its own env var, then assembles `.env` on disk via `printf`. This keeps each secret an independent value — GitHub's log masker can match and redact each one in isolation.

```yaml
- name: Render .env from individual secrets
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    LINE_CHANNEL_ACCESS_TOKEN: ${{ secrets.LINE_CHANNEL_ACCESS_TOKEN }}
    # ... (full list in the workflow)
    TOKEN_ENCRYPTION_KEY: ${{ secrets.TOKEN_ENCRYPTION_KEY }}
  run: |
    umask 077
    : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY secret is missing or empty}"
    # ... fail-fast for every required secret
    {
      printf 'ANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_API_KEY"
      # ... one printf per variable
      printf 'PORT=3000\n'
    } > "$DEPLOY_DIR/.env"
    chmod 600 "$DEPLOY_DIR/.env"
```

Security properties:

- `umask 077` guarantees the file is created `0600` even if `chmod` is skipped.
- Each secret is log-masked **individually** by GitHub Actions. A single multiline blob would be matched as one token and may silently fail to mask when split across lines — the per-variable approach avoids that failure mode.
- `printf '%s\n'` (not `echo`) preserves each value verbatim, independent of the shell's backslash-escape behavior.
- `: "${VAR:?...}"` fails the job with a specific message naming the missing key — no "empty .env" guessing games.
- Non-sensitive constants (`PORT=3000`) live in the workflow itself; no need to store them as secrets or variables.

The resulting `.env` stays under `gha-runner`'s home with `0600` permissions. Only `gha-runner` and `root` can read it.

---

## 4. Testing the secret end-to-end

After §2 is complete, trigger a dev deploy by pushing anything to `develop`:

```bash
# A doc-only no-op push is safe
git checkout develop
git pull
# Make any trivial docs change, commit, and push
git push origin develop
```

Expected Actions timeline:

1. `Deploy to dev` workflow run appears on <https://github.com/Sana-Labo/sanalabo-automation/actions>
2. Job lands on `sanalabo-onprem-runner-01`
3. Steps succeed in order: Bootstrap → Fetch → Render .env → Build → Start with `--wait` → Prune
4. Environments page (<https://github.com/Sana-Labo/sanalabo-automation/deployments>) shows a new `dev` deployment with the pushed SHA

On failure, the `Report container status` step (which runs `if: always()`) prints `docker compose ps` and the last 50 log lines — inspect those first before digging into the runner itself.

---

## 5. Rotation

### Routine rotation

Rotating a single credential touches **one** secret — this is the direct win over the old monolithic pattern:

1. Generate the new credential (e.g., new ANTHROPIC API key at the provider console)
2. Update the corresponding secret at <https://github.com/Sana-Labo/sanalabo-automation/settings/environments/dev/edit>
3. Trigger a deploy (push a no-op commit to `develop`, or rerun the latest successful workflow)
4. Confirm via `Report container status` that the container started with the new env

Because the workflow writes `.env` on every run, step 3 is what actually applies the rotation. Skipping it means the server keeps the old `.env`.

### Emergency rotation (suspected leak)

Add these steps to the routine flow:

- Revoke the compromised credential at its source (Anthropic console, LINE Developers console, Google Cloud, Cloudflare dashboard)
- Rotate `TOKEN_ENCRYPTION_KEY` — but note this invalidates all existing encrypted OAuth tokens in `data/workspaces/`. Users must re-authorize GWS.
- Audit `journalctl -u actions.runner...` and `docker compose logs` for the leak window
- Rotate the runner registration token per [runner.md §9](./runner.md#9-quarterly-token-rotation-runbook) if the leak path touched the runner

---

## 6. Secret inventory (forward reference)

**Environment `dev`** (registered in this PR):

| Secret | Used by |
|--------|---------|
| `ANTHROPIC_API_KEY` | agent loop |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE MCP send |
| `LINE_CHANNEL_SECRET` | LINE webhook signature verify |
| `SYSTEM_ADMIN_IDS` | admin allowlist |
| `GOOGLE_CLIENT_ID` | GWS OAuth |
| `GOOGLE_CLIENT_SECRET` | GWS OAuth |
| `GOOGLE_REDIRECT_URI` | GWS OAuth callback URL |
| `TOKEN_ENCRYPTION_KEY` | encrypted token store (AES-256-GCM master key) |

**Environment `prod`** (PR 4): same eight names, separate values. Reviewer gate required for deploys.

**Repository scope** (PR 5):

| Secret | Used by |
|--------|---------|
| `LINE_NOTIFY_CHANNEL_TOKEN` | operator notifications from both workflows |
| `OPERATOR_LINE_USER_ID` | notification target userId |

`LINE_NOTIFY_CHANNEL_TOKEN` is repo-level (not environment-level) because it carries operator-notification-only rights — it does not grant access to app user data. Splitting it per environment would add bookkeeping with no real isolation gain.

---

## 7. Troubleshooting

### Workflow run shows "Waiting for review" but dev has no approval rule

The environment's **Deployment branches** rule does not match the branch that pushed. Verify §2.1 step 3 includes `develop`. Symptoms: the run pauses at the job level with "Waiting for a reviewer" despite no reviewer configured — GitHub rejects the branch before the job queues.

### `Render .env` step prints `<KEY> secret is missing or empty`

The named secret is not registered under the `dev` environment (or exists at repo-level instead), or the workflow is missing `environment: dev` on the job. Environment secrets only resolve when the job declares that environment. Register the secret at <https://github.com/Sana-Labo/sanalabo-automation/settings/environments/dev/edit> and rerun.

### Container fails healthcheck on first deploy

Inspect the printed `docker compose logs` from the `Report container status` step. Most common: a required env var holds an invalid value (e.g., wrong `ANTHROPIC_API_KEY` format). The agent startup will crash with a clear message. Update the corresponding secret via §5 Routine rotation and redeploy.

### `Fetch target SHA` fails with `Host key verification failed` / `Could not read from remote repository`

The fetch is resolving the repository URL via SSH even though the workflow declares `REPO_URL` as HTTPS. This happens when a `url.<ssh>.insteadOf = <https>` rewrite exists in the runner's **system** (`/etc/gitconfig`) or **global** (`~/.gitconfig`) config, or when a stale `.git/config` under `$DEPLOY_DIR` has an SSH remote — any of which causes git to switch transports before honoring the workflow's HTTPS URL. SSH then fails because `gha-runner`'s `~/.ssh/known_hosts` does not include `github.com`.

The `Fetch target SHA` step is isolated against all of these with three measures (do **not** remove them, even if the underlying runner config looks clean today):

```yaml
env:
  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  GIT_CONFIG_GLOBAL: /dev/null
  GIT_CONFIG_SYSTEM: /dev/null
run: |
  AUTH_HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
  git -C "$DEPLOY_DIR" \
    -c "http.extraheader=$AUTH_HEADER" \
    fetch --depth=1 "$REPO_URL" "$GITHUB_SHA"
```

| Measure | Purpose |
|---------|---------|
| `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_SYSTEM=/dev/null` | Git ignores both `/etc/gitconfig` and `$HOME/.gitconfig`, neutralizing any `url.*.insteadOf`, `core.sshCommand`, or credential helper in those files |
| Fetch passes `"$REPO_URL"` directly (not `origin`) | Bypasses whatever URL is stored in `$DEPLOY_DIR/.git/config`'s `remote.origin.url` |
| `http.extraheader` (unscoped) with basic `x-access-token:$GITHUB_TOKEN` | Authenticated HTTPS fetch matching actions/checkout's proven pattern. URL-scoped keys (e.g. `http.https://github.com/.extraheader`) are **not** used because `git -c` receives the entire `key=value` as one shell argument, and git's config parser cannot reliably split section/subsection boundaries when the URL contains `.` and `/`; the header silently fails to apply and git falls back to interactive credential prompting (`fatal: could not read Username ...`). Since this fetch only targets github.com, unscoped `http.extraheader` is safe |

The settings cover all four transport-override paths (system, global, local, env) in one pass. If you must debug the underlying cause separately, check `sudo cat /etc/gitconfig`, `git config --system --get-regexp '^url\.'` as `gha-runner`, and `cat $DEPLOY_DIR/.git/config`.

### Old `.env` kept after secret rotation

You rotated the secret but skipped a redeploy. The workflow only rewrites `.env` when it runs. Push an empty commit or rerun the last successful workflow:

```bash
git commit --allow-empty -m "chore: trigger dev redeploy"
git push origin develop
```

---

## 8. References

- [GitHub Docs — Using secrets in GitHub Actions](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions)
- [GitHub Docs — Using environments for deployment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
- [GitHub Docs — Deployment branches and tags](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment#deployment-branches-and-tags)
- Design proposal: [docs/design/phase4-cicd.md](../design/phase4-cicd.md)
- Runner guide: [docs/deployment/runner.md](./runner.md)
