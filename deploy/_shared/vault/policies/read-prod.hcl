# Grants prod-environment GitHub Actions jobs read access to prod secrets only.
# Bound to the `gha-prod` JWT role (bound_claims.environment = "prod").
# Design: docs/design/phase4-vault.md §6.3.

path "secret/data/prod/*" {
  capabilities = ["read"]
}

path "secret/metadata/prod/*" {
  capabilities = ["list"]
}
