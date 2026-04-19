# Vault Agent configuration — AppRole auto-auth + API proxy listener.
# Design: docs/design/phase4-vault.md §6.x (introduced in PR 4-a).
#
# The agent keeps a fresh Vault token in memory and transparently attaches it
# to requests forwarded from the sanalabo-automation app, so the app never
# handles Vault tokens directly. Running one agent per environment (dev/prod)
# presents a distinct AppRole identity to Vault.

# Vault server address. The Vault server container publishes only to host
# loopback (127.0.0.1:8200 — see deploy/_shared/vault/docker-compose.yml),
# which is unreachable from sibling containers via the bridge gateway. The
# agent therefore joins the Vault compose project's external Docker network
# (`vault_default`) alongside the app's default network, and resolves the
# server by its compose DNS name. Each env compose must declare
# `vault_default` as an external network and attach vault-agent to it.
vault {
  address = "http://vault:8200"
}

auto_auth {
  method "approle" {
    mount_path = "auth/approle"
    config = {
      role_id_file_path   = "/vault/secrets/role-id"
      secret_id_file_path = "/vault/secrets/secret-id"
      # The deploy workflow writes role-id / secret-id as plain files
      # (not wrapped tokens), and the agent re-reads them on every auth.
      # Switching to response wrapping requires rotating the ingress path too.
      remove_secret_id_file_after_reading = false
    }
  }

  # No sinks. The API proxy listener consumes the auto-auth token directly;
  # persisting it to disk would widen the blast radius on host compromise.
}

# Transparent forwarding for client API calls. The app posts to
# http://vault-agent:8100/v1/transit/{encrypt,decrypt}/tokens and the agent
# attaches X-Vault-Token before forwarding to the Vault server.
api_proxy {
  use_auto_auth_token = true
}

listener "tcp" {
  address     = "0.0.0.0:8100"
  tls_disable = true
}
