# minecraft-skin

HydCraft 的 Minecraft 皮肤渲染服务，兼容现有 mc-heads 调用路径：

- `GET /head/:player`：180 × 180 等距立体头像
- `GET /body/:player`：高度 432 的等距全身像
- `GET /avatar/:player`：180 × 180 平面头像（含帽子层）
- `GET /skin/:player`：原始皮肤 PNG

`player` 支持 Minecraft 用户名、UUID 或 texture ID。服务不再请求
`mc-heads.net`；NMSR 直接查询 Mojang 官方 API 和纹理服务。

## Production architecture

```text
Client -> EdgeOne -> BaoTa Nginx -> Adapter -> NMSR -> Mojang
                                      Docker network
```

`Adapter` 是稳定的公开兼容层，负责路径转换、统一 CORS / 缓存头和
`/avatar` 生成。`NMSR` 只负责玩家资料解析和渲染。两者运行在同一个
Docker Compose 项目中；NMSR 不映射到宿主机端口。

## Repository and deployment model

GitHub 是唯一源码仓库；CNB 是同步镜像、构建机和 Docker 制品库：

```text
GitHub main push -> GitHub Actions sync -> CNB
GitHub manual Deploy -> sync -> CNB API trigger -> build images -> SSH deploy
CNB web trigger -> build images -> SSH deploy
```

CNB 在其构建机中编译固定版本的 NMSR，并推送两个不可变的 commit tag
镜像。上海生产机仅登录制品库、拉取镜像并运行：从不编译 Rust、Node 或
Docker image。

## Project layout

```text
src/worker.js                    # 旧 Cloudflare Worker，仅作迁移期回退
deploy/adapter/                  # 自维护的 Node HTTP compatibility adapter
deploy/nmsr/                     # 固定 NMSR revision 的 CI-only Dockerfile
deploy/compose.prod.yaml         # 宝塔生产机运行定义；没有 build 指令
.cnb/                            # CNB build + SSH deploy pipeline
.github/workflows/ci.yml         # CI + GitHub -> CNB sync
.github/workflows/deploy.yml     # GitHub 手动触发 CNB API deploy
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
for CNB, so executing `docker compose up --build` on the production host is an
invalid deployment method.

## First-time production host setup

Create the project directory and copy the template once. The real `.env` stays
only on the server and is preserved by all later CNB deployments.

```bash
install -d -m 755 /www/wwwroot/minecraft-skin
cd /www/wwwroot/minecraft-skin
cat > .env <<'EOF'
CNB_DOCKER_PULL_TOKEN=replace-with-read-only-cnb-token
ADAPTER_HOST_PORT=18080
EOF
chmod 600 .env
```

After the first CNB deployment, create a BaoTa Website for
`mc-heads.hydcraft.cn` and configure its reverse proxy target as:

```text
http://127.0.0.1:18080
```

Do not expose port `18080` in the firewall. BaoTa Nginx owns TLS and public
HTTP; Docker only listens on loopback.

## Required configuration

### GitHub Actions

Repository variable:

```text
CNB_REPOSITORY_SLUG=HydCraft/minecraft-skin
```

Repository secrets:

```text
CNB_TOKEN=<CNB token that can push Git to HydCraft/minecraft-skin>
CNB_API_TOKEN=<CNB API token that can start builds>
```

### CNB secret repository

Create `HydCraft/hydcraft-secrets` file `minecraft-skin-deploy.yml` with:

```yaml
MINECRAFT_SKIN_DEPLOY_HOST: your-server-host-or-ip
MINECRAFT_SKIN_DEPLOY_USER: root
MINECRAFT_SKIN_DEPLOY_SSH_PORT: '233'
MINECRAFT_SKIN_DEPLOY_SSH_PRIVATE_KEY: |
  -----BEGIN OPENSSH PRIVATE KEY-----
  replace-with-the-private-key-used-only-for-deployment
  -----END OPENSSH PRIVATE KEY-----
MINECRAFT_SKIN_REMOTE_DEPLOY_PATH: /www/wwwroot/minecraft-skin
```

Do not place `CNB_DOCKER_PULL_TOKEN` in CNB secrets. It belongs only in the
production server's `/www/wwwroot/minecraft-skin/.env`, because it is consumed
by Docker on that server.

## Deployment entry points

1. **GitHub Actions**: run the `Deploy` workflow manually. It syncs `main` to
   CNB and invokes CNB event `api_trigger_deploy`.
2. **CNB**: open `HydCraft/minecraft-skin`, choose `web_trigger_deploy`, then
   start it manually. This is useful if GitHub is unavailable.

Both paths execute the same CNB pipeline and deploy the same immutable image
tag. A successful deployment leaves `deploy/images.env` on the server; it
records the exact NMSR and Adapter images required for rollback.

## Rollback

On the production server, set `NMSR_IMAGE` and `ADAPTER_IMAGE` in
`deploy/images.env` to the previous commit tags, then run:

```bash
cd /www/wwwroot/minecraft-skin
docker compose --env-file .env --env-file images.env -f compose.prod.yaml up -d --no-build
```

The NMSR texture and profile cache is stored in the named Docker volume
`minecraft-skin_nmsr-cache`, so normal image upgrades do not discard it.
