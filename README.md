# minecraft-skin

HydCraft's self-hosted Minecraft skin rendering service. It preserves the
existing mc-heads-compatible public routes while using NMSR and Mojang's
official services instead of requesting `mc-heads.net`.

- `GET /head/:player`: 180 x 180 isometric head render.
- `GET /body/:player`: isometric full-body render with a height of 432.
- `GET /avatar/:player`: 180 x 180 flat face render with the hat layer.
- `GET /skin/:player`: original skin PNG.

`player` accepts a Minecraft username, UUID, or texture ID.

## Production architecture

```text
Client -> EdgeOne -> Self-hosted Nginx -> Adapter -> NMSR -> Mojang
                                               Docker network
```

The Adapter is the stable public compatibility layer. It owns route
translation, CORS, cache headers, and `/avatar` generation. NMSR only resolves
player data and renders skins. Both services run in one Docker Compose project;
NMSR does not expose a host port.

## Repository and deployment model

GitHub is the only source repository. CNB is the synchronized mirror, build
environment, and Docker artifact registry.

```text
GitHub main push -> GitHub Actions sync -> CNB
GitHub manual Deploy -> sync -> CNB API trigger -> build images -> SSH deploy
CNB web trigger -> build images -> SSH deploy
```

CNB compiles the pinned NMSR revision and publishes two immutable images tagged
with the commit SHA. The production host only authenticates to the registry,
pulls images, and runs them; it never builds Rust, Node.js, or Docker images.

## Project layout

```text
src/worker.js                    # Legacy Cloudflare Worker kept for rollback
deploy/adapter/                  # Maintained Node.js HTTP compatibility adapter
deploy/nmsr/                     # Pinned NMSR revision and CI-only Dockerfile
deploy/compose.prod.yaml         # Production runtime definition; no build key
.cnb/                            # CNB image build and SSH deployment pipeline
.github/workflows/ci.yml         # CI and GitHub-to-CNB synchronization
.github/workflows/deploy.yml     # Manual GitHub trigger for CNB deployment
```

## Local validation

```powershell
pnpm install --frozen-lockfile
pnpm check
docker compose `
  --env-file deploy/.env.example `
  --env-file deploy/images.env.example `
  -f deploy/compose.prod.yaml config -q
```

The Compose file intentionally cannot build images. Image creation is reserved
for CNB, so `docker compose up --build` is not a valid production deployment
method.

## First-time production host setup

Create the runtime directory and its host-only `.env` file once. Subsequent
CNB deployments preserve this file.

```bash
install -d -m 755 /www/wwwroot/minecraft-skin
cd /www/wwwroot/minecraft-skin
cat > .env <<'EOF'
CNB_DOCKER_PULL_TOKEN=replace-with-read-only-cnb-token
ADAPTER_HOST_PORT=18080
EOF
chmod 600 .env
```

After the first CNB deployment, configure your self-hosted Nginx virtual host
for `mc-heads.hydcraft.cn` to proxy requests to:

```text
http://127.0.0.1:18080
```

Nginx owns public HTTP and TLS. Do not expose port `18080` through the
firewall; Docker binds it to loopback only.

## Required configuration

### GitHub Actions

Repository variable:

```text
CNB_REPOSITORY_SLUG=HydCraft/minecraft-skin
```

Repository secrets:

```text
CNB_TOKEN=<CNB token with Git push permission for HydCraft/minecraft-skin>
CNB_API_TOKEN=<CNB token that can start builds>
```

### CNB KeyStore repository

Copy [`.cnb/examples/minecraft-skin-deploy.example.yml`](.cnb/examples/minecraft-skin-deploy.example.yml)
to `HydCraft/hydcraft-secrets` as `minecraft-skin-deploy.yml`, then replace
every placeholder. The template defines the allowed repository, branches,
events, and all SSH deployment settings.

Do not place `CNB_DOCKER_PULL_TOKEN` in CNB KeyStore. It belongs only in the
production host's `/www/wwwroot/minecraft-skin/.env`, where Docker consumes it.

## Deployment entry points

1. **GitHub Actions:** Run the `Deploy` workflow manually. It synchronizes
   `main` to CNB and invokes the `api_trigger_deploy` event.
2. **CNB:** Open `HydCraft/minecraft-skin`, select `web_trigger_deploy`, and
   start it manually. This is useful when GitHub is unavailable.

Both paths execute the same CNB pipeline and deploy the same immutable image
tag. A successful deployment writes `images.env` to the runtime directory; it
records the exact NMSR and Adapter image tags required for rollback.

## Rollback

On the production host, set `NMSR_IMAGE` and `ADAPTER_IMAGE` in `images.env`
to the previous commit tags, then run:

```bash
cd /www/wwwroot/minecraft-skin
docker compose --env-file .env --env-file images.env -f compose.prod.yaml up -d --no-build
```

The NMSR texture and profile cache is stored in the named Docker volume
`minecraft-skin_nmsr-cache`, so ordinary image upgrades do not discard it.
