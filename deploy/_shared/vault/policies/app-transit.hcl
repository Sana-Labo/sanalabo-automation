# Grants the application runtime encrypt/decrypt access to the Transit key
# named `tokens`. Attached to whatever identity the app authenticates as
# (AppRole, vault-agent, etc. — decided in PR 4-a).
# Design: docs/design/phase4-vault.md §6.5.
#
# Transit's encrypt and decrypt endpoints are `update`, not `create` or
# `read` — this is a Vault convention where the request body changes state
# (counter advances, key version selection) and the response returns data.

path "transit/encrypt/tokens" {
  capabilities = ["update"]
}

path "transit/decrypt/tokens" {
  capabilities = ["update"]
}
