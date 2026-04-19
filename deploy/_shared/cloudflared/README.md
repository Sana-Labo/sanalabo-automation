# Shared Cloudflare Tunnel

Single `cloudflared` container that routes every hostname for every environment
of every service on this host. Referenced by `docs/design/phase4-cicd.md` §7.1.

## Files

| File | Tracked | Purpose |
|------|---------|---------|
| `docker-compose.yml` | yes | Cloudflared container definition |
| `config.yml.example` | yes | Ingress template with placeholder UUID |
| `config.yml` | no (gitignored) | Runtime routing table — server only |
| `creds.json` | no (gitignored) | Tunnel credentials — server only |

## One-time host setup

The shared container lives at `/home/gha-runner/deploy/_shared/cloudflared/`
on the home server. Commands run as `gha-runner`.

```bash
# 1) Create the external Docker network once. Both this compose project and
#    every service compose (sanalabo-automation-{dev,prod}, future services)
#    attach to it.
docker network create cf_tunnel

# 2) Create a locally managed tunnel on a workstation that has cloudflared
#    installed and is logged in (`cloudflared tunnel login` → cert.pem).
cloudflared tunnel create sanalabo-shared        # prints UUID; writes ~/.cloudflared/<uuid>.json
cloudflared tunnel route dns sanalabo-shared agent-dev.sanalabo.com
cloudflared tunnel route dns sanalabo-shared agent.sanalabo.com

# 3) Copy the credentials and config to the server.
scp ~/.cloudflared/<uuid>.json timothy-dev-ts:/tmp/creds.json
ssh timothy-dev-ts "sudo -u gha-runner install -m 600 /tmp/creds.json \
  /home/gha-runner/deploy/_shared/cloudflared/creds.json && rm /tmp/creds.json"

# 4) Copy config.yml.example → config.yml, substitute the UUID, place on server.
# (Edit locally, then scp + install as above, or edit in place as gha-runner.)

# 5) Start the shared tunnel.
cd /home/gha-runner/deploy/_shared/cloudflared
docker compose up -d
docker compose logs --tail=20 cloudflared     # look for "Registered tunnel connection"
```

Cloudflare automatically creates proxied CNAME records for each `route dns`
hostname.

## Adding a hostname

1. Append an entry to `config.yml` above the `http_status:404` catch-all.
2. If the hostname is new (not already `route dns`'d), register it:
   `cloudflared tunnel route dns sanalabo-shared <new-hostname>`.
3. `docker compose up -d` in this directory — cloudflared reloads routing
   without dropping existing connections.

## Operational notes

- This container is **independent of app deploys**. App `docker compose up -d`
  does not restart cloudflared, so LINE webhooks do not drop during redeploys.
- `creds.json` and `config.yml` are local runtime state. Treat them like
  secrets: perm `600`, owned by `gha-runner`, never committed.
- Rotating credentials: `cloudflared tunnel token --cred-file sanalabo-shared`
  generates a fresh JSON. Replace `creds.json` and `docker compose restart`.
