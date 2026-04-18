# Grants dev-environment GitHub Actions jobs read access to dev secrets only.
# Bound to the `gha-dev` JWT role (bound_claims.environment = "dev").
# Design: docs/design/phase4-vault.md §6.3.

# KV v2 stores the latest secret version under the `data/` prefix. `read` is
# the capability the vault-action plugin needs to fetch values.
path "secret/data/dev/*" {
  capabilities = ["read"]
}

# `list` on `metadata/` lets tooling enumerate keys under the prefix without
# exposing values. Useful for drift detection; harmless without `read`.
path "secret/metadata/dev/*" {
  capabilities = ["list"]
}
