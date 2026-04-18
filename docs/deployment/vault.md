# Vault — Secret Management Backplane

Operational runbook for the self-hosted HashiCorp Vault instance that holds dev/prod secrets and the application's Transit encryption key. Replaces `docs/deployment/ci-secrets.md` as the long-term secret source (ci-secrets.md remains as an emergency fallback until PR 3 lands).

**Design reference:** [docs/design/phase4-vault.md](../design/phase4-vault.md)
**Runner setup:** [docs/deployment/runner.md](./runner.md)

---

## 1. Overview

| Property | Value |
|----------|-------|
| **Image** | `hashicorp/vault:1.18` |
| **Host bind** | `127.0.0.1:8200` (no external exposure) |
| **Storage** | `raft` integrated, single node |
| **Auth** | `jwt` against GitHub OIDC (`token.actions.githubusercontent.com`) |
| **Secrets engine** | `kv` v2 at `secret/` + `transit` at `transit/` |
| **Deploy path on host** | `~gha-runner/deploy/_shared/vault/` |
| **Repo source path** | `deploy/_shared/vault/` — copy this to the host verbatim |
| **Unseal shares** | `-key-shares=1 -key-threshold=1` (see [phase4-vault.md §11.1](../design/phase4-vault.md#11-decisions-needed)) |
| **Unseal key storage** | Apple Keychain on the operator's macOS workstation, iCloud-synced |

**Who needs what access:**

| Actor | How it authenticates | What it can do |
|-------|----------------------|----------------|
| GitHub Actions `deploy-dev.yml` | JWT via OIDC, role `gha-dev` | `read` on `secret/data/dev/*` |
| GitHub Actions `deploy-prod.yml` | JWT via OIDC, role `gha-prod` | `read` on `secret/data/prod/*` |
| App runtime | AppRole or vault-agent (PR 4-a) | `encrypt`/`decrypt` on `transit/*/tokens` |
| Operator (you) | Root token (bootstrap) → admin token (day-to-day) | Full admin, then scoped |

---

## 2. Prerequisites

On the target server (`ssh timothy-dev-ts`):

- [ ] Self-hosted runner already set up per [runner.md](./runner.md)
- [ ] `gha-runner` user owns `~gha-runner/deploy/` and is in the `docker` group
- [ ] Docker Compose v2 available (`docker compose version`)
- [ ] Outbound HTTPS to `token.actions.githubusercontent.com` permitted (for JWT discovery)

On your macOS workstation:

- [ ] `security` CLI available (default on macOS)
- [ ] Signed in to iCloud and iCloud Keychain enabled (`System Settings → Apple ID → iCloud → Passwords & Keychain`) — this is what gives the unseal key its resilience against single-machine loss
- [ ] `ssh timothy-dev-ts` works without password prompt

---

## 3. One-time setup

Run sections 3.1 through 3.10 exactly once when bringing Vault up for the first time.

### 3.1 Copy config to the home server

From the repo working copy on your workstation:

```bash
rsync -av --delete \
  --exclude='data/' --exclude='audit/' \
  deploy/_shared/vault/ \
  timothy-dev-ts:/tmp/vault-stage/

# On the server, move into place and hand to the runner user
ssh timothy-dev-ts "sudo rsync -av /tmp/vault-stage/ ~gha-runner/deploy/_shared/vault/ \
  && sudo chown -R gha-runner:gha-runner ~gha-runner/deploy/_shared/vault/ \
  && rm -rf /tmp/vault-stage/"
```

The `.gitignore`'d `data/` and `audit/` directories are created by Docker on first boot; they must not be overwritten by the rsync.

### 3.2 Start Vault

```bash
ssh timothy-dev-ts "sudo -u gha-runner -H bash -c \
  'cd ~gha-runner/deploy/_shared/vault && docker compose up -d vault'"

# Verify container state (will be "unhealthy" until we initialize + unseal)
ssh timothy-dev-ts "docker ps --filter name=vault"
```

### 3.3 Initialize

```bash
ssh timothy-dev-ts "docker exec vault vault operator init \
  -key-shares=1 \
  -key-threshold=1 \
  -format=json" > /tmp/vault-init.json

# Sanity-check the output shape
jq 'keys' /tmp/vault-init.json
# Expected: ["recovery_keys_b64","recovery_keys_hex","root_token","unseal_keys_b64","unseal_keys_hex"]
```

`/tmp/vault-init.json` now contains the unseal key (one entry, `unseal_keys_b64[0]`) and root token. **Do not commit, email, or leave this file on disk.** The next step moves both values into Keychain, after which you delete the file.

### 3.4 Store unseal key + root token in Apple Keychain

```bash
UNSEAL_KEY=$(jq -r '.unseal_keys_b64[0]' /tmp/vault-init.json)
ROOT_TOKEN=$(jq -r '.root_token' /tmp/vault-init.json)

security add-generic-password \
  -a vault-admin \
  -s home-vault-unseal-key \
  -w "$UNSEAL_KEY" \
  -U

security add-generic-password \
  -a vault-admin \
  -s home-vault-root-token \
  -w "$ROOT_TOKEN" \
  -U

# Confirm retrieval before destroying the file
security find-generic-password -a vault-admin -s home-vault-unseal-key -w >/dev/null && echo "unseal key stored"
security find-generic-password -a vault-admin -s home-vault-root-token -w >/dev/null && echo "root token stored"

# Destroy the plaintext file
shred -u /tmp/vault-init.json 2>/dev/null || rm -P /tmp/vault-init.json
unset UNSEAL_KEY ROOT_TOKEN
```

Option flags:
- `-a` account, `-s` service: the tuple `(vault-admin, home-vault-unseal-key)` is how the item is located. Keep these names exactly — scripts and the §4 procedures depend on them.
- `-w` writes the password value. Subsequent reads use `-w` without a value to print it.
- `-U` updates the item if it already exists (idempotent).

### 3.5 First unseal

```bash
UNSEAL_KEY=$(security find-generic-password -a vault-admin -s home-vault-unseal-key -w)
ssh timothy-dev-ts "docker exec vault vault operator unseal $UNSEAL_KEY"
unset UNSEAL_KEY

# Confirm
ssh timothy-dev-ts "docker exec vault vault status" | grep -E 'Sealed|Initialized'
# Expected: Sealed: false, Initialized: true
```

### 3.6 Enable JWT auth and configure the role

All subsequent admin commands need the root token. Fetch it once and export to the remote shell:

```bash
ROOT_TOKEN=$(security find-generic-password -a vault-admin -s home-vault-root-token -w)
```

Enable the method:

```bash
ssh timothy-dev-ts "docker exec -e VAULT_TOKEN=$ROOT_TOKEN vault \
  vault auth enable jwt"

ssh timothy-dev-ts "docker exec -e VAULT_TOKEN=$ROOT_TOKEN vault \
  vault write auth/jwt/config \
    bound_issuer='https://token.actions.githubusercontent.com' \
    oidc_discovery_url='https://token.actions.githubusercontent.com'"
```

Create the `gha-dev` role (prod role is added in PR 4):

```bash
ssh timothy-dev-ts "docker exec -e VAULT_TOKEN=$ROOT_TOKEN vault \
  vault write auth/jwt/role/gha-dev \
    role_type=jwt \
    user_claim=sub \
    bound_claims_type=glob \
    bound_claims='{\"repository\":\"Sana-Labo/sanalabo-automation\",\"environment\":\"dev\"}' \
    bound_audiences=https://vault.home.local \
    token_policies=read-dev \
    token_ttl=15m \
    token_max_ttl=15m"
```

The `bound_claims` ensures only our repo's `dev` environment jobs can authenticate as this role. `bound_audiences` must match what vault-action sends (`jwtGithubAudience`).

### 3.7 Write policies

The HCL files are already on the host under `~gha-runner/deploy/_shared/vault/policies/`. Pipe each into `vault policy write`:

```bash
for policy in read-dev read-prod app-transit; do
  ssh timothy-dev-ts "docker exec -i -e VAULT_TOKEN=$ROOT_TOKEN vault \
    vault policy write $policy - < ~gha-runner/deploy/_shared/vault/policies/$policy.hcl"
done

# Verify
ssh timothy-dev-ts "docker exec -e VAULT_TOKEN=$ROOT_TOKEN vault vault policy list"
# Expected includes: default, read-dev, read-prod, app-transit, root
```

`read-prod` is loaded now so the prod-role creation in PR 4 has nothing new to install.

### 3.8 Enable KV v2

```bash
ssh timothy-dev-ts "docker exec -e VAULT_TOKEN=$ROOT_TOKEN vault \
  vault secrets enable -path=secret -version=2 kv"
```

Secrets get loaded in PR 3 (dev) and PR 4 (prod) — not here.

### 3.9 Enable Transit engine and create `tokens` key

```bash
ssh timothy-dev-ts "docker exec -e VAULT_TOKEN=$ROOT_TOKEN vault \
  vault secrets enable transit"

ssh timothy-dev-ts "docker exec -e VAULT_TOKEN=$ROOT_TOKEN vault \
  vault write -f transit/keys/tokens \
    type=aes256-gcm96 \
    exportable=false \
    deletion_allowed=false"

# Verify
ssh timothy-dev-ts "docker exec -e VAULT_TOKEN=$ROOT_TOKEN vault \
  vault read transit/keys/tokens"
# Expected: type=aes256-gcm96, min_decryption_version=1, latest_version=1
```

- `exportable=false` — the key material never leaves Vault. Clients can only ask Vault to encrypt/decrypt.
- `deletion_allowed=false` — prevents an accidental `vault delete transit/keys/tokens` from making all existing ciphertexts permanently unreadable.

App ↔ Vault authentication (so the app can call `transit/encrypt/tokens` at runtime) is out of scope for this PR; PR 4-a picks either AppRole or vault-agent and implements it end-to-end.

### 3.10 Revoke the root token

Day-to-day admin work should use a scoped token, not root:

```bash
ssh timothy-dev-ts "docker exec -e VAULT_TOKEN=$ROOT_TOKEN vault \
  vault token revoke $ROOT_TOKEN"

# Remove from Keychain once you are confident the rotation worked
# (keep the Keychain entry until you have created and tested a replacement admin token — covered in the "Create admin token" follow-up, outside this PR)
unset ROOT_TOKEN
```

If you skip this step the root token is valid forever and sits in Keychain, which enlarges blast radius if the workstation is compromised. For this PR, revoking root without a replacement admin token is acceptable — subsequent admin tasks can use a short-lived recovery procedure (regenerate root via unseal key, see §7.3).

---

## 4. Daily operations

### 4.1 Unseal after reboot

Vault seals itself whenever the container restarts (after host reboot, `docker compose restart`, or OOM kill). The deploy workflow will fail until you unseal:

```bash
UNSEAL_KEY=$(security find-generic-password -a vault-admin -s home-vault-unseal-key -w)
ssh timothy-dev-ts "docker exec vault vault operator unseal $UNSEAL_KEY"
unset UNSEAL_KEY
```

Confirm:
```bash
ssh timothy-dev-ts "docker exec vault vault status" | grep Sealed
# Expected: Sealed    false
```

### 4.2 Rotate a secret value

Admin token must be set (obtain via §7.3 if needed). To rotate `ANTHROPIC_API_KEY` in dev:

```bash
NEW_VALUE='sk-ant-...'
ssh timothy-dev-ts "docker exec -e VAULT_TOKEN=$ADMIN_TOKEN -i vault \
  vault kv put secret/dev/ANTHROPIC_API_KEY value=$NEW_VALUE"
unset NEW_VALUE
```

KV v2 preserves the previous version — roll back with `vault kv rollback -version=N secret/dev/ANTHROPIC_API_KEY`.

Trigger a re-deploy to pick up the new value (e.g. empty commit on `develop`).

### 4.3 Rotate the Transit `tokens` key

```bash
ssh timothy-dev-ts "docker exec -e VAULT_TOKEN=$ADMIN_TOKEN vault \
  vault write -f transit/keys/tokens/rotate"
```

Existing ciphertexts remain decryptable — Vault tracks key version per ciphertext and keeps archived versions. New encryptions use the new version automatically. Optional rewrap (forcing all stored ciphertexts onto the latest version) is done via `transit/rewrap/tokens` and is typically scheduled quarterly or after a suspected compromise, not on every rotation.

### 4.4 Inspect audit trail

Once the file audit device is enabled (PR 5):

```bash
ssh timothy-dev-ts "sudo tail -f ~gha-runner/deploy/_shared/vault/audit/vault.log" | jq .
```

Every secret read, login, and policy change appears as a JSON line with the requester's identity (GitHub OIDC `sub`, or the admin token accessor).

---

## 5. Apple Keychain management

### 5.1 Common operations

Add or overwrite an item (idempotent):
```bash
security add-generic-password -a vault-admin -s <service> -w <value> -U
```

Read the value:
```bash
security find-generic-password -a vault-admin -s <service> -w
```

Delete:
```bash
security delete-generic-password -a vault-admin -s <service>
```

### 5.2 iCloud Keychain sync and resilience

The operator's macOS is the authoritative copy. iCloud Keychain replicates it to any other Apple device signed in with the same Apple ID and with Keychain sync enabled. This is the main defense against single-workstation loss:

- **Laptop dies:** sign into another Mac/iPhone/iPad with the same Apple ID — the keychain items appear within minutes.
- **Apple ID lost (password forgotten, account locked):** no recovery path. Treat this as a full Vault re-initialization event (see §7.1).

Verify sync status: `System Settings → Apple ID → iCloud → Passwords & Keychain` should show "On" and the listed devices should include at least two independent Apple devices (laptop + phone is sufficient).

### 5.3 Backup to an additional vault (optional)

If iCloud sync feels like too narrow a recovery base, export the unseal key to a second password manager (1Password family account, etc.) at your own discretion. **Do not** export to a file on the home server, to Google Drive, or to any unencrypted channel. The threat model explicitly puts the key outside the home-server blast radius.

---

## 6. Backups

Raft storage snapshots are set up in PR 5. Until then, treat Vault data as recoverable only by re-entering secrets manually. A one-off snapshot can be taken at any time:

```bash
ssh timothy-dev-ts "docker exec -e VAULT_TOKEN=$ADMIN_TOKEN vault \
  vault operator raft snapshot save /vault/audit/vault-$(date +%Y%m%d).snap"
```

The resulting file is AES-encrypted with the master key derived from the unseal key, so it is safe at rest but useless without Keychain access.

---

## 7. Troubleshooting

### 7.1 Full re-initialization (Apple ID lost, snapshots unavailable)

When the unseal key cannot be recovered, Vault cannot be unsealed and no stored secret is reachable. Path forward:

1. **Revoke everything at source.** Rotate API keys at their respective providers: Anthropic, LINE Developers, Google Cloud OAuth credentials, Cloudflare. Anything fetched from Vault is now untrusted.
2. **Wipe Vault storage.** `ssh timothy-dev-ts "sudo rm -rf ~gha-runner/deploy/_shared/vault/data/*"` — this destroys everything; confirm you are in the recovery scenario first.
3. **Re-run §3** from 3.2 onwards. Store new unseal key + root token. Re-create roles, policies, engines.
4. **Re-enter new secrets** via `vault kv put` (PR 3/4 procedures).
5. **Re-authenticate all OAuth users.** Because the Transit `tokens` key is new, all stored `tokens.enc` files in `data/workspaces/*/` are unreadable. Users must run the OAuth flow again.

Expected wall time: 30 min – 1 h for a proficient operator.

### 7.2 Vault container will not become healthy

```bash
ssh timothy-dev-ts "docker logs vault --tail=50"
```

Common causes:

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Vault is sealed` on every health probe | Post-reboot and not yet unsealed | §4.1 |
| `failed to setup raft cluster: ... permission denied` | `data/` is owned by root after an `rsync` mishap | `sudo chown -R gha-runner:gha-runner ~gha-runner/deploy/_shared/vault/data` |
| `bind: address already in use` | Port 8200 already bound on the host | `sudo lsof -iTCP:8200 -sTCP:LISTEN` to find the culprit |
| `cannot allocate memory` or `mlock failed` | `IPC_LOCK` cap missing | Confirm `cap_add: [IPC_LOCK]` in compose, re-up |

### 7.3 Regenerate root token

Root was revoked in §3.10. To regain admin access (e.g. to create a scoped admin token or rotate a secret), use the unseal key to generate a one-shot root:

```bash
UNSEAL_KEY=$(security find-generic-password -a vault-admin -s home-vault-unseal-key -w)

# Start root generation; outputs a nonce and OTP
OTP=$(ssh timothy-dev-ts "docker exec vault vault operator generate-root -init -format=json" | jq -r '.otp')
NONCE=$(ssh timothy-dev-ts "docker exec vault vault operator generate-root -status -format=json" | jq -r '.nonce')

# Provide the unseal key with the nonce
ENCODED=$(ssh timothy-dev-ts "docker exec vault vault operator generate-root \
  -nonce=$NONCE \
  $UNSEAL_KEY" | grep 'Encoded Token' | awk '{print $NF}')

# Decode with the OTP to get the new root token
NEW_ROOT=$(ssh timothy-dev-ts "docker exec vault vault operator generate-root -decode=$ENCODED -otp=$OTP")
echo "New root token: $NEW_ROOT"

# Use it, then revoke as in §3.10
unset UNSEAL_KEY OTP NONCE ENCODED NEW_ROOT
```

This is the designed escape hatch — a single-use admin resurrection that still requires the unseal key. If you lose the unseal key, this path is also closed, and §7.1 is the only remedy.

### 7.4 `vault-action` fails with `permission denied` in a workflow

Check:
1. The job's `environment:` matches the role's `bound_claims.environment` (typos are the usual cause — `dev` vs `Dev`).
2. The workflow has `permissions: id-token: write`, otherwise GitHub refuses to mint the OIDC token.
3. `vault audit` (once enabled) shows the `login` attempt and Vault's reason for rejection — most informative diagnostic.
