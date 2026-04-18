# Vault server configuration — see docs/design/phase4-vault.md §6.1.
#
# Single-node raft storage. Listener is inside the container on 0.0.0.0:8200;
# the compose file binds that to host 127.0.0.1:8200 only.

storage "raft" {
  path    = "/vault/data"
  node_id = "vault-onprem-01"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1
}

# api_addr/cluster_addr advertise the address Vault announces to clients.
# We use the host-side 127.0.0.1 because the loopback binding is the only
# reachable surface. If an additional listener is added for remote admin
# (e.g. Tailscale), revisit cluster_addr as well.
api_addr     = "http://127.0.0.1:8200"
cluster_addr = "http://127.0.0.1:8201"

ui = true
