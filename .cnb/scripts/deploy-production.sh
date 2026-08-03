#!/usr/bin/env bash

set -euo pipefail

require_env() {
  local name="$1"

  if [ -z "${!name:-}" ]; then
    echo "DEPLOY_CONFIGURATION_MISSING: $name is required" >&2
    exit 1
  fi
}

for required_env in \
  MINECRAFT_SKIN_DEPLOY_HOST \
  MINECRAFT_SKIN_DEPLOY_USER \
  MINECRAFT_SKIN_DEPLOY_SSH_PRIVATE_KEY; do
  require_env "$required_env"
done

SSH_PORT="${MINECRAFT_SKIN_DEPLOY_SSH_PORT:-233}"
REMOTE_DEPLOY_PATH="${MINECRAFT_SKIN_REMOTE_DEPLOY_PATH:-/www/wwwroot/minecraft-skin}"
REMOTE_TEMP_DIR="/tmp/minecraft-skin-deploy-${CNB_BUILD_ID:-manual}"

test -f deploy-artifact/compose.prod.yaml
test -f deploy-artifact/images.env

install -d -m 700 ~/.ssh
printf '%s\n' "$MINECRAFT_SKIN_DEPLOY_SSH_PRIVATE_KEY" > ~/.ssh/deploy_key
chmod 600 ~/.ssh/deploy_key
ssh-keyscan -p "$SSH_PORT" "$MINECRAFT_SKIN_DEPLOY_HOST" >> ~/.ssh/known_hosts

cat > ~/.ssh/config <<EOF
Host deploy-host
  HostName $MINECRAFT_SKIN_DEPLOY_HOST
  User $MINECRAFT_SKIN_DEPLOY_USER
  Port $SSH_PORT
  IdentityFile ~/.ssh/deploy_key
  StrictHostKeyChecking yes
  ServerAliveInterval 10
  ServerAliveCountMax 3
  ConnectTimeout 30
EOF
chmod 600 ~/.ssh/config

ssh deploy-host "mkdir -p '$REMOTE_TEMP_DIR'"
rsync -az --delete deploy-artifact/ "deploy-host:$REMOTE_TEMP_DIR/"

ssh deploy-host \
  "export REMOTE_DEPLOY_PATH='$REMOTE_DEPLOY_PATH' REMOTE_TEMP_DIR='$REMOTE_TEMP_DIR'; bash -s" <<'EOF'
set -euo pipefail

if [ ! -f "$REMOTE_DEPLOY_PATH/.env" ]; then
  echo 'DEPLOY_RUNTIME_MISSING_ENV: create the production .env file before deployment' >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo 'DEPLOY_RUNTIME_MISSING_DOCKER_COMPOSE: Docker Compose is required on the remote host' >&2
  exit 1
fi

rsync -a --no-owner --no-group --delete --exclude='.env' \
  "$REMOTE_TEMP_DIR/" \
  "$REMOTE_DEPLOY_PATH/"

cd "$REMOTE_DEPLOY_PATH"
set -a
source <(sed 's/\r$//' ./.env)
set +a

if [ -z "${CNB_DOCKER_PULL_TOKEN:-}" ]; then
  echo 'DEPLOY_RUNTIME_MISSING_REGISTRY_TOKEN: CNB_DOCKER_PULL_TOKEN is required in the remote .env file' >&2
  exit 1
fi

printf '%s' "$CNB_DOCKER_PULL_TOKEN" | docker login docker.cnb.cool -u cnb --password-stdin
docker compose --env-file .env --env-file images.env -f compose.prod.yaml config -q
docker compose --env-file .env --env-file images.env -f compose.prod.yaml pull
docker compose --env-file .env --env-file images.env -f compose.prod.yaml up -d --no-build --remove-orphans

running_services="$(docker compose --env-file .env --env-file images.env -f compose.prod.yaml ps --status running --services | sort)"
expected_services=$'adapter\nnmsr'
if [ "$running_services" != "$expected_services" ]; then
  echo "DEPLOY_RUNTIME_UNHEALTHY: expected adapter and nmsr to be running, got: $running_services" >&2
  exit 1
fi

rm -rf "$REMOTE_TEMP_DIR"
EOF
