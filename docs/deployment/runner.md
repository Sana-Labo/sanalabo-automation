# Self-hosted GitHub Actions Runner

Installation, operation, and rotation guide for the self-hosted runner that executes Phase 4 deploy workflows on the Sana-Labo home server.

**Design reference:** [docs/design/phase4-cicd.md](../design/phase4-cicd.md)

---

## 1. Overview

The runner is the bridge between GitHub Actions and the home server.

| Property | Value |
|----------|-------|
| **Hostname (registered)** | `sanalabo-onprem-runner-01` |
| **Label** | `home-server` |
| **Scope** | Organization (`Sana-Labo`) — picked up by any repo via `runs-on: [self-hosted, home-server]` |
| **System user** | `gha-runner` (no-login shell, in `docker` group) |
| **Install path** | `/opt/actions-runner/` |
| **Deploy roots** | `~gha-runner/deploy/<service>/{dev,prod}/` and `~gha-runner/deploy/_shared/` |
| **Service** | systemd, auto-start on boot |

**Why self-hosted (not GitHub-hosted):** the server is reachable only via Tailscale. A cloud runner would need either Tailscale-in-runner (slow, fragile) or public SSH (unwanted). See [phase4-cicd.md §3](../design/phase4-cicd.md#3-why-self-hosted-runner-recap).

---

## 2. Prerequisites

On the target server (`ssh timothy-dev-ts`):

- [ ] Ubuntu 22.04 or 24.04
- [ ] Docker Engine + Compose v2 already installed and running (`docker ps` works)
- [ ] Tailscale connected (`tailscale status` shows the host online)
- [ ] `timothy01` has `sudo` and is **not** the same identity as the runner
- [ ] At least 5 GB free disk under `/opt` (runner binary + work dir)
- [ ] Outbound HTTPS to `*.github.com` and `*.actions.githubusercontent.com` permitted

GitHub side:

- [ ] You are an admin of the `Sana-Labo` GitHub organization
- [ ] You can navigate to **Org Settings → Actions → Runners → New self-hosted runner**

---

## 3. Create the `gha-runner` system user

The runner runs under a dedicated user — never as `timothy01` — to isolate it from your personal SSH keys, dotfiles, and shell history.

```bash
# On the server
sudo useradd \
  --system \
  --create-home \
  --home-dir /home/gha-runner \
  --shell /usr/sbin/nologin \
  --comment "GitHub Actions self-hosted runner" \
  gha-runner

# Add to docker group so the runner can drive `docker compose`
sudo usermod -aG docker gha-runner

# Verify
id gha-runner
# Expected: uid=... gid=... groups=...,docker
```

> `--shell /usr/sbin/nologin` blocks interactive login. Service workflows still execute under this user via systemd. Use `sudo -u gha-runner -H bash` if you ever need an interactive shell for debugging.

---

## 4. Migrate `~timothy01/deploy/` → `~gha-runner/deploy/`

Per the design decision, all deploy artifacts move under the runner user's home for clean ownership. Existing layout is removed.

### 4.1 Inventory + back up `.env` files

```bash
# As timothy01
ls -la ~/deploy/ 2>/dev/null
find ~/deploy -name '.env' -type f 2>/dev/null
```

Even with no custom `docker-compose.yml`, environment files **must** be preserved — they hold OAuth tokens, channel secrets, and per-environment overrides that are not in git. Copy them to a timestamped backup outside `~/deploy/`:

```bash
BACKUP=~/deploy-env-backup-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP"
find ~/deploy -name '.env' -type f -exec sh -c '
  for f; do
    rel=${f#'"$HOME"'/deploy/}
    dst='"$BACKUP"'/$rel
    mkdir -p "$(dirname "$dst")"
    cp -p "$f" "$dst"
  done
' _ {} +
ls -laR "$BACKUP"
```

The backup stays under `timothy01`'s home; it is restored into `~gha-runner/deploy/` at §4.4 (last sub-step). After successful restoration and a passing smoke test in §8, delete the backup.

If `~timothy01/deploy/` does not exist (fresh setup), skip to §4.4.

### 4.2 Stop running containers

```bash
cd ~/deploy/sanalabo-automation 2>/dev/null && docker compose down || true
```

> `down` (not just `stop`) — we are about to recreate from a different path.

### 4.3 Move the directory

```bash
sudo mv /home/timothy01/deploy /home/gha-runner/deploy
sudo chown -R gha-runner:gha-runner /home/gha-runner/deploy
sudo chmod -R u=rwX,g=rX,o= /home/gha-runner/deploy
```

> The old path no longer exists. Update any local notes, aliases, or shell history references.

### 4.4 Create canonical structure (fresh or post-migration)

```bash
sudo -u gha-runner -H mkdir -p \
  /home/gha-runner/deploy/sanalabo-automation/dev \
  /home/gha-runner/deploy/sanalabo-automation/prod \
  /home/gha-runner/deploy/_shared/cloudflared
```

The `_shared/cloudflared/` subtree is populated in PR 4. Empty for now.

### 4.5 Restore `.env` backups (post-migration only)

If §4.1 produced a backup, copy each `.env` into the new tree:

```bash
# As timothy01 (knows where backup lives), with sudo to write into gha-runner home
BACKUP=$(ls -1dt ~/deploy-env-backup-* | head -1)

sudo find "$BACKUP" -name '.env' -type f | while read -r src; do
  rel=${src#"$BACKUP"/}
  dst=/home/gha-runner/deploy/$rel
  sudo install -o gha-runner -g gha-runner -m 600 "$src" "$dst"
  echo "restored: $dst"
done
```

After §8 passes, remove the backup:

```bash
rm -rf "$BACKUP"
```

---

## 5. Install the runner binary

GitHub releases the runner at <https://github.com/actions/runner/releases>. Pin to a specific version; do not blindly `latest`. This guide uses **v2.333.1** (linux-x64), the version verified in our install.

```bash
# Pinned version + published SHA-256 (from the release page)
RUNNER_VERSION=2.333.1
RUNNER_SHA256=18f8f68ed1892854ff2ab1bab4fcaa2f5abeedc98093b6cb13638991725cab74

# Create the install dir owned by gha-runner (750: runner reads/writes, others blocked)
sudo install -d -o gha-runner -g gha-runner -m 750 /opt/actions-runner

# Download to /tmp as timothy01 — avoids "permission denied" when curl tries to
# write into a cwd it can't traverse, and keeps the tarball off the runner tree
cd /tmp
curl -fLO \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"

# Verify checksum before extraction
echo "${RUNNER_SHA256}  actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" | sha256sum -c -

# Extract into /opt/actions-runner, then reset ownership recursively
sudo tar -C /opt/actions-runner -xzf "actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
sudo chown -R gha-runner:gha-runner /opt/actions-runner
rm "actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
```

> **Architecture note:** if the server is ARM64 (e.g., a future Mac mini or RPi), substitute `linux-arm64` in the filename and use the matching SHA from the release page.

---

## 6. Register at organization scope

### 6.1 Generate a registration token (GitHub UI)

1. <https://github.com/organizations/Sana-Labo/settings/actions/runners>
2. **New self-hosted runner** → **Linux**
3. Copy the registration token from the displayed `./config.sh --url ... --token ...` block. **The token is single-use and expires in 1 hour.**

### 6.2 Allow self-hosted runners on public repositories

By default, GitHub **blocks** public repositories from using org-scoped self-hosted runners. This is a deliberate safeguard: a malicious fork PR could otherwise run arbitrary code on your server. Since `sanalabo-automation` is public, we must explicitly opt in — and pair it with the 4-layer defense described in §6.4 and §10.

1. <https://github.com/organizations/Sana-Labo/settings/actions/runner-groups>
2. Open the **Default** runner group (or the group you registered the runner under)
3. Tick **Allow public repositories**
4. **Save**

Without this, `runs-on: [self-hosted, home-server]` on any public repo will queue forever (see §10).

### 6.3 Run `config.sh` (on server, as `gha-runner`)

```bash
cd /opt/actions-runner

sudo -u gha-runner -H ./config.sh \
  --url https://github.com/Sana-Labo \
  --token <REGISTRATION_TOKEN> \
  --name sanalabo-onprem-runner-01 \
  --labels home-server \
  --work _work \
  --unattended \
  --replace
```

| Flag | Why |
|------|-----|
| `--url https://github.com/Sana-Labo` | Org-level (no `/repo` suffix) → reusable across repos |
| `--name sanalabo-onprem-runner-01` | Display name in GitHub UI |
| `--labels home-server` | Workflows target via `runs-on: [self-hosted, home-server]` |
| `--work _work` | Job workspace; default but explicit |
| `--unattended` | No interactive prompts |
| `--replace` | Idempotent; overwrites a registration with the same name |

> Successful output ends with `√ Runner successfully added` and `√ Runner connection is good`.

### 6.4 Require approval for fork PR workflows

Allowing public-repo access (§6.2) means a first-time contributor could submit a fork PR whose workflow runs on your hardware. GitHub's per-repo approval gate closes this hole.

1. <https://github.com/Sana-Labo/sanalabo-automation/settings/actions>
2. Under **Fork pull request workflows from outside collaborators**
3. Select **Require approval for all external contributors**
4. **Save**

The stricter "first-time contributors" tier auto-promotes a contributor after one approved run — insufficient once an account is compromised. "All external contributors" re-checks org membership on every run.

---

## 7. Install as a systemd service (manual unit)

Older runners shipped a `svc.sh` helper that generated a systemd unit. **v2.333.1 no longer includes `svc.sh`** (the file is absent from the tarball), so we write the unit ourselves. The unit name follows the convention `svc.sh` used to produce, so existing docs and muscle memory still apply.

### 7.1 Harden the registration credentials

`config.sh` writes `.runner` and `.credentials` (containing the runner's long-lived auth material) with default permissions. Tighten them before enabling the service:

```bash
cd /opt/actions-runner
sudo chmod 600 .runner .credentials .credentials_rsaparams 2>/dev/null || true
sudo chown gha-runner:gha-runner .runner .credentials .credentials_rsaparams 2>/dev/null || true
ls -la .runner .credentials
# Expected: -rw------- gha-runner gha-runner ...
```

### 7.2 Write the systemd unit

```bash
SERVICE=actions.runner.Sana-Labo.sanalabo-onprem-runner-01.service

# Use `echo ... | sudo tee` — heredoc-free, sandbox-friendly, single tee invocation
echo '[Unit]
Description=GitHub Actions Runner (Sana-Labo.sanalabo-onprem-runner-01)
After=network.target

[Service]
ExecStart=/opt/actions-runner/run.sh
User=gha-runner
WorkingDirectory=/opt/actions-runner
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=5min
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target' | sudo tee "/etc/systemd/system/${SERVICE}" > /dev/null
```

Key design choices:

| Directive | Rationale |
|-----------|-----------|
| `KillMode=process` + `SIGTERM` + `TimeoutStopSec=5min` | The runner traps SIGTERM and finishes the in-flight job before exiting. Avoids killing a deploy mid-compose. |
| `Restart=always` + `RestartSec=15` | Recover from transient network/GitHub issues without hammering systemd's restart rate-limiter. |
| `User=gha-runner` | Runs under the dedicated system user — never as root, never as `timothy01`. |
| No `EnvironmentFile` | Secrets are passed per-workflow via GitHub Actions secrets, not baked into the unit. |

### 7.3 Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE"
sudo systemctl start "$SERVICE"

# Verify
sudo systemctl status "$SERVICE" --no-pager
# Expected: Active: active (running), recent journal line "Listening for Jobs"

sudo journalctl -u "$SERVICE" -f          # live logs; Ctrl-C to detach
```

Expected `status` output ends with `Active: active (running)` and the journal shows `√ Connected to GitHub` followed by `Listening for Jobs`.

---

## 8. Verification

### 8.1 GitHub UI

<https://github.com/organizations/Sana-Labo/settings/actions/runners>

The runner should appear with:
- Name: `sanalabo-onprem-runner-01`
- Status: **Idle** (green dot)
- Labels: `self-hosted`, `Linux`, `X64`, `home-server`

### 8.2 Smoke-test workflow

Create a throwaway workflow on a scratch branch. We use `on: push` (not `workflow_dispatch`) because Phase 4 deploys are push-triggered — the smoke test should exercise the same trigger path:

```yaml
# .github/workflows/runner-smoke.yml  (on a branch like test/runner-smoke)
name: Runner smoke test
on:
  push:
    branches: [test/runner-smoke]
jobs:
  ping:
    runs-on: [self-hosted, home-server]
    steps:
      - run: |
          echo "Hostname: $(hostname)"
          echo "User: $(whoami)"
          docker --version
          docker compose version
```

```bash
# From a local clone
git checkout -b test/runner-smoke
git add .github/workflows/runner-smoke.yml
git commit -m "test: runner smoke"
git push -u origin test/runner-smoke
```

The job should land on `sanalabo-onprem-runner-01` within seconds and complete green. After success, delete the branch both locally and on origin:

```bash
git checkout develop
git branch -D test/runner-smoke
git push origin --delete test/runner-smoke
```

If the job stays queued, jump to §10 "Workflow stays queued, never picked up" — the most common cause on a public repo is a missing §6.2 opt-in.

---

## 9. Quarterly token rotation runbook

Self-hosted runner OAuth tokens auto-renew internally, but periodic full re-registration enforces muscle memory for the "token suspected compromised" path and clears any drift in registration metadata.

**Cadence:** every 3 months. Add a recurring calendar event titled **"Rotate `sanalabo-onprem-runner-01` token"** with a link to this section.

### Procedure

```bash
SERVICE=actions.runner.Sana-Labo.sanalabo-onprem-runner-01.service

# 1. Stop the service so the runner isn't picking up jobs mid-rotation
sudo systemctl stop "$SERVICE"

# 2. Get a fresh registration token from GitHub UI
#    (same path as §6.1)

# 3. De-register the existing runner from GitHub
cd /opt/actions-runner
sudo -u gha-runner -H ./config.sh remove --token <REMOVAL_TOKEN>
#    The removal token is shown alongside the registration token in the UI.

# 4. Re-register with the new registration token
sudo -u gha-runner -H ./config.sh \
  --url https://github.com/Sana-Labo \
  --token <NEW_REGISTRATION_TOKEN> \
  --name sanalabo-onprem-runner-01 \
  --labels home-server \
  --work _work \
  --unattended \
  --replace

# 5. Re-tighten credential permissions (config.sh may relax them)
sudo chmod 600 .runner .credentials .credentials_rsaparams 2>/dev/null || true

# 6. Restart the service
sudo systemctl start "$SERVICE"
sudo systemctl status "$SERVICE" --no-pager

# 7. Trigger the smoke-test workflow (§8.2) to confirm
```

**Expected total time:** ~5 minutes. If you encounter any "runner offline" state in GitHub UI lasting more than 1 minute after step 5, check `journalctl -u <service>` for connection errors.

### Emergency rotation (suspected compromise)

Skip the calendar — execute the procedure immediately. After step 5, also:

- Audit recent workflow runs for unexpected jobs
- Rotate any GitHub Secrets the runner accessed (`DEV_ENV_FILE`, `PROD_ENV_FILE`, `LINE_NOTIFY_CHANNEL_TOKEN`)
- Review `journalctl -u <service> --since "30 days ago"` for anomalies

---

## 10. Troubleshooting

### Runner shows offline immediately after install

1. `sudo systemctl status <service>` — is the service running?
2. `journalctl -u <service> -n 100` — look for HTTPS / DNS / token errors
3. From the server: `curl -I https://api.github.com` — confirm outbound network
4. Tailscale-only egress? Confirm `*.github.com` is reachable, not just internal Tailscale hosts

### `docker compose` fails inside a workflow with permission denied

`gha-runner` is missing the `docker` group. Re-add and restart:

```bash
SERVICE=actions.runner.Sana-Labo.sanalabo-onprem-runner-01.service
sudo usermod -aG docker gha-runner
sudo systemctl restart "$SERVICE"
```

The runner process must be restarted for new group membership to take effect.

### `journalctl` or `systemctl status` hangs / pages

The system pager intercepts non-interactive sessions. Already mitigated for `timothy01` via `~/.bashrc` and `/etc/environment` (`SYSTEMD_PAGER=""`). If it recurs in a fresh shell:

```bash
SYSTEMD_PAGER="" sudo systemctl status <service>
```

### Workflow stays queued, never picked up

Check in order — the first three cover nearly every case:

1. **Labels match exactly**: workflow `runs-on: [self-hosted, home-server]` ↔ runner has the `home-server` label (GitHub UI → runner detail). Missing/misspelled labels fail silently.
2. **Runner group includes the repo**: **Org Settings → Actions → Runner groups** → Default (or the registered group) → **Repository access** must include the target repo.
3. **Public repository access enabled** (public repos only): same page → **Allow public repositories** must be ticked. Without this, a public repo submits the job and waits forever without any warning. This is the #1 cause on first install for `sanalabo-automation`. See §6.2.
4. **Runner is idle and online**: GitHub UI → Runners → runner row shows a green dot + "Idle". If grey/red, jump to "Runner shows offline immediately after install" above.
5. **Stale duplicate registration**: more than one runner with the same name drops jobs. Use `--replace` on `config.sh` or remove the stale one in the UI.

### Uninstalling the service

`svc.sh` is not present on v2.333.1+, so uninstall is done directly via systemd:

```bash
SERVICE=actions.runner.Sana-Labo.sanalabo-onprem-runner-01.service
sudo systemctl stop "$SERVICE"
sudo systemctl disable "$SERVICE"
sudo rm "/etc/systemd/system/${SERVICE}"
sudo systemctl daemon-reload
```

To also remove the registration from GitHub, run `config.sh remove` (see §9 step 3) before deleting the unit. The binary under `/opt/actions-runner` can then be removed with `sudo rm -rf /opt/actions-runner`.

---

## 11. References

- [GitHub Docs — About self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners)
- [GitHub Docs — Adding self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/adding-self-hosted-runners)
- [GitHub Docs — Configuring the runner application as a service](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/configuring-the-self-hosted-runner-application-as-a-service)
- [Runner releases](https://github.com/actions/runner/releases)
- Design proposal: [docs/design/phase4-cicd.md](../design/phase4-cicd.md)
