# Shared vault-agent sidecar template

Reference configuration for the per-environment Vault Agent sidecars that
authenticate the sanalabo-automation app to Vault Transit. Introduced in
Phase 4 PR 4-a; see `docs/design/phase4-vault.md` and
`docs/deployment/vault.md` for the broader design.

## Role

Each environment (dev, prod) runs one `vault-agent` container alongside the
app container. The agent:

1. Authenticates to the local Vault server with its own **AppRole** role
   (`sanalabo-automation-dev`, `sanalabo-automation-prod`).
2. Keeps the resulting Vault token in memory via **auto-auth**.
3. Exposes an **API proxy listener** on `:8100`. The app posts
   `POST /v1/transit/{encrypt,decrypt}/tokens` to the agent; the agent
   transparently attaches `X-Vault-Token` and forwards to the Vault server.

The app never sees a Vault token. Compromise of the app container yields a
fetch-only capability scoped to the agent's lifetime, not Vault-wide access.

## Files

| File | Tracked | Purpose |
|------|---------|---------|
| `config.hcl` | yes | Agent configuration (identical across dev/prod) |
| `docker-compose.yml` | yes | Service definition consumed by env compose via `extends:` |
| `.gitignore` | yes | Excludes runtime secrets |
| `vault-secrets/` | no (gitignored) | Per-env AppRole `role-id` / `secret-id` rendered by the deploy workflow |

## Extends pattern

Each env compose (`sanalabo-automation/{dev,prod}/docker-compose.yml`)
reuses this template so the image, command, and healthcheck stay in lockstep:

```yaml
services:
  vault-agent:
    extends:
      file: ../../_shared/vault-agent/docker-compose.yml
      service: vault-agent
    container_name: sanalabo-automation-dev-vault-agent   # (or -prod-…)
    networks: [app]
    volumes:
      # Extends already mounts config.hcl; add the per-env AppRole secrets.
      - ./vault-secrets/role-id:/vault/secrets/role-id:ro
      - ./vault-secrets/secret-id:/vault/secrets/secret-id:ro
  assistant:
    depends_on:
      vault-agent:
        condition: service_healthy
    environment:
      VAULT_AGENT_URL: http://vault-agent:8100
    networks: [app]
networks:
  app:
```

## Operational notes

- `role-id` is effectively a public identifier; `secret-id` is the sensitive
  half. The deploy workflow fetches both from Vault KV (`secret/<env>/VAULT_ROLE_ID`,
  `secret/<env>/VAULT_SECRET_ID`) and writes them to `vault-secrets/` on the
  runner with `0600`. Rotation: re-issue `secret-id` (see
  `docs/deployment/vault.md` §AppRole), update the KV value, redeploy.
- AppRole auth is provisioned once per env using a Vault root token
  generated through `vault operator generate-root`; see the Task #8 guide
  in the PR body for the exact command sequence.
- The agent talks to Vault over `http://host.docker.internal:8200` (Linux
  `host-gateway` alias). Any future switch to a remote Vault requires
  revisiting both `config.hcl` and the `extra_hosts` line.
