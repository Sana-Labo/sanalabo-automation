# CI/CD Secrets & Environments

> **Status — superseded for `dev`.** As of Phase 4 PR 3, `deploy-dev.yml` fetches secrets from the on-prem Vault instance via GitHub OIDC + JWT auth (see [docs/design/phase4-vault.md](../design/phase4-vault.md) and [docs/deployment/vault.md](./vault.md)). The `DEV_ENV_FILE` environment secret described below is no longer consumed by the workflow and can be deleted from GitHub (`Settings → Environments → dev → DEV_ENV_FILE`).
>
> The `prod` environment still uses the GitHub Environment Secrets model documented here until PR 4 migrates it. Operator-notification secrets (`LINE_NOTIFY_CHANNEL_TOKEN`, `OPERATOR_LINE_USER_ID`) remain repo-level and are unaffected by the Vault migration.

How GitHub Actions obtains the credentials it needs to deploy to the home server. Covers the GitHub Environment Secrets pattern — retained as the historical intermediate stage for `dev` (superseded by Vault in PR 3) and still active for `prod` (until PR 4).

**Design reference:** [docs/design/phase4-cicd.md §5.3](../design/phase4-cicd.md#53-secret-management) · [docs/design/phase4-vault.md](../design/phase4-vault.md) (current dev pattern)
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

### 2.2 Prepare the `DEV_ENV_FILE` value

The secret holds the **full contents** of the server's `.env` file for the dev environment. Start from `.env.example` and fill in dev-specific values:

```bash
# On your workstation (not the server)
cp .env.example /tmp/dev.env
# Edit /tmp/dev.env with dev credentials:
#   - ANTHROPIC_API_KEY (dev project key)
#   - LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET (dev LINE channel)
#   - SYSTEM_ADMIN_IDS (dev test user IDs)
#   - GOOGLE_* (dev OAuth client)
#   - TOKEN_ENCRYPTION_KEY (new value; never reuse prod's)
#   - CF_TUNNEL_TOKEN (leave empty for PR 3 — tunnel bundling moves to PR 4's shared cloudflared)
```

Key constraints:

- Separate `ANTHROPIC_API_KEY` from prod to keep usage/billing distinct.
- Separate `LINE_CHANNEL_*` — dev uses a different LINE channel so test messages do not hit real users.
- `TOKEN_ENCRYPTION_KEY` is a fresh 32-byte random value; leaking dev's key must not expose prod tokens.
- Trailing newline at EOF is fine; `printf '%s'` in the workflow preserves the file verbatim.
- **No BOM, no CRLF.** Use LF line endings — `docker compose` env parsing is LF-only.

### 2.3 Upload as an environment secret

1. <https://github.com/Sana-Labo/sanalabo-automation/settings/environments/dev/edit>
2. **Environment secrets → Add secret**
3. Name: **`DEV_ENV_FILE`** (exact)
4. Value: paste the full contents of `/tmp/dev.env`
5. **Add secret**

Verify: the secrets list now shows `DEV_ENV_FILE` with a timestamp. Delete the local copy:

```bash
rm /tmp/dev.env
```

> **Why not repository-level secret?** A repo secret would leak into any branch's workflow. Environment secrets only appear when a job declares `environment: dev`, and branch rules further restrict which branches can claim that environment.

---

## 3. How the workflow consumes the secret

`.github/workflows/deploy-dev.yml` renders the secret onto disk in a single protected step:

```yaml
- name: Render .env from DEV_ENV_FILE
  env:
    DEV_ENV_FILE: ${{ secrets.DEV_ENV_FILE }}
  run: |
    umask 077
    printf '%s' "$DEV_ENV_FILE" > "$DEPLOY_DIR/.env"
    chmod 600 "$DEPLOY_DIR/.env"
```

Security properties:

- `umask 077` guarantees the file is created `0600` even if `chmod` is skipped.
- GitHub Actions auto-masks secret values in logs — a stray `echo` would render as `***`. Still, we avoid `echo`ing the contents intentionally.
- `printf '%s'` (not `echo`) preserves the value verbatim; `echo` would interpret backslash escapes on some shells.
- The env-var indirection (`env: DEV_ENV_FILE: ${{ ... }}`) avoids putting the secret value into the shell command string, where a malformed `.env` line could theoretically cause parsing surprises.

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

Secrets are rotated by updating the value in the GitHub UI — **no server login needed**:

1. Generate new credentials (e.g., new ANTHROPIC API key)
2. Edit `/tmp/dev.env` with the new value (reuse §2.2 procedure)
3. Update `DEV_ENV_FILE` at <https://github.com/Sana-Labo/sanalabo-automation/settings/environments/dev/edit>
4. Trigger a deploy (push a no-op commit, or rerun the latest successful workflow)
5. Confirm via `Report container status` that the container started with the new env

Because the workflow writes `.env` on every run, step 4 is what actually applies the rotation. Skipping it means the server keeps the old `.env`.

### Emergency rotation (suspected leak)

Add these steps to the routine flow:

- Revoke the compromised credential at its source (Anthropic console, LINE Developers console, Google Cloud, Cloudflare dashboard)
- Rotate `TOKEN_ENCRYPTION_KEY` — but note this invalidates all existing encrypted OAuth tokens in `data/workspaces/`. Users must re-authorize GWS.
- Audit `journalctl -u actions.runner...` and `docker compose logs` for the leak window
- Rotate the runner registration token per [runner.md §9](./runner.md#9-quarterly-token-rotation-runbook) if the leak path touched the runner

---

## 6. Secret inventory (forward reference)

| Secret | Scope | Added in | Used by |
|--------|-------|----------|---------|
| `DEV_ENV_FILE` | environment: `dev` | **PR 3 (this PR)** | `deploy-dev.yml` |
| `PROD_ENV_FILE` | environment: `prod` | PR 4 | `deploy-prod.yml` |
| `LINE_NOTIFY_CHANNEL_TOKEN` | repository | PR 5 | both deploy workflows (operator notifications) |
| `OPERATOR_LINE_USER_ID` | repository | PR 5 | both deploy workflows |

`LINE_NOTIFY_CHANNEL_TOKEN` is repo-level (not environment-level) because it carries operator-notification-only rights — it does not grant access to app user data. Splitting it per environment would add bookkeeping with no real isolation gain.

---

## 7. Troubleshooting

### Workflow run shows "Waiting for review" but dev has no approval rule

The environment's **Deployment branches** rule does not match the branch that pushed. Verify §2.1 step 3 includes `develop`. Symptoms: the run pauses at the job level with "Waiting for a reviewer" despite no reviewer configured — GitHub rejects the branch before the job queues.

### `Render .env` step prints `DEV_ENV_FILE secret is empty or unset`

The secret exists under the wrong scope (repo-level instead of `dev` environment) or the workflow is missing `environment: dev` on the job. Environment secrets only resolve when the job has declared that environment.

### Container fails healthcheck on first deploy

Inspect the printed `docker compose logs` from the `Report container status` step. Most common: a required env var is missing from `DEV_ENV_FILE` (e.g., forgot `ANTHROPIC_API_KEY`). The agent startup will crash with a clear message. Add the missing value via §5 Routine rotation and redeploy.

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
