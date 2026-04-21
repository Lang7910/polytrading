#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="${APP_NAME:-polytrading-web}"
IMAGE_NAME="${IMAGE_NAME:-polytrading-web}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
HOST_PORT="${HOST_PORT:-13000}"
CONTAINER_PORT="${CONTAINER_PORT:-13000}"

POLYMARKET_CLOB_URL="${POLYMARKET_CLOB_URL:-https://clob.polymarket.com}"
NEXT_PUBLIC_ENABLE_GAMMA="${NEXT_PUBLIC_ENABLE_GAMMA:-true}"
NEXT_PUBLIC_POLYMARKET_GAMMA_URL="${NEXT_PUBLIC_POLYMARKET_GAMMA_URL:-https://gamma-api.polymarket.com}"
NEXT_PUBLIC_POLYMARKET_WS_URL="${NEXT_PUBLIC_POLYMARKET_WS_URL:-wss://ws-subscriptions-clob.polymarket.com/ws/market}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"
FULL_IMAGE="$IMAGE_NAME:$IMAGE_TAG"

usage() {
  cat <<EOF
Usage: ./deploy.sh <command>

Commands:
  deploy      Build the Docker image and start the app container.
  update      Pull latest git changes when available, then deploy.
  clean       Stop/remove the app container and remove the app image.
  redeploy    Clean, rebuild, and start the app container.
  restart     Restart the running app container.
  status      Show container status and recent logs.
  logs        Follow app logs.

Environment overrides:
  APP_NAME=$APP_NAME
  IMAGE_NAME=$IMAGE_NAME
  IMAGE_TAG=$IMAGE_TAG
  HOST_PORT=$HOST_PORT
EOF
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required but was not found in PATH." >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "docker is installed but the daemon is not reachable." >&2
    exit 1
  fi
}

container_exists() {
  docker ps -a --format '{{.Names}}' | grep -Fxq "$APP_NAME"
}

image_exists() {
  docker image inspect "$FULL_IMAGE" >/dev/null 2>&1
}

stop_container() {
  if container_exists; then
    echo "Stopping $APP_NAME..."
    docker stop "$APP_NAME" >/dev/null || true
    docker rm "$APP_NAME" >/dev/null || true
  fi
}

build_image() {
  echo "Building $FULL_IMAGE from $APP_DIR..."
  docker build \
    --build-arg "NEXT_PUBLIC_ENABLE_GAMMA=$NEXT_PUBLIC_ENABLE_GAMMA" \
    --build-arg "NEXT_PUBLIC_POLYMARKET_GAMMA_URL=$NEXT_PUBLIC_POLYMARKET_GAMMA_URL" \
    --build-arg "NEXT_PUBLIC_POLYMARKET_WS_URL=$NEXT_PUBLIC_POLYMARKET_WS_URL" \
    -t "$FULL_IMAGE" \
    "$APP_DIR"
}

start_container() {
  stop_container
  echo "Starting $APP_NAME on host port $HOST_PORT..."
  docker run -d \
    --name "$APP_NAME" \
    --restart unless-stopped \
    -p "$HOST_PORT:$CONTAINER_PORT" \
    -e "NODE_ENV=production" \
    -e "PORT=$CONTAINER_PORT" \
    -e "HOSTNAME=0.0.0.0" \
    -e "POLYMARKET_CLOB_URL=$POLYMARKET_CLOB_URL" \
    -e "NEXT_PUBLIC_POLYMARKET_GAMMA_URL=$NEXT_PUBLIC_POLYMARKET_GAMMA_URL" \
    "$FULL_IMAGE" >/dev/null
  echo "Deployed: http://localhost:$HOST_PORT"
}

deploy() {
  require_docker
  build_image
  start_container
}

pull_latest_if_possible() {
  if git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Pulling latest changes in $APP_DIR..."
    git -C "$APP_DIR" pull --ff-only
  else
    echo "No git repository found; skipping pull."
  fi
}

clean() {
  require_docker
  stop_container
  if image_exists; then
    echo "Removing image $FULL_IMAGE..."
    docker rmi "$FULL_IMAGE" >/dev/null
  fi
  echo "Clean complete."
}

status() {
  require_docker
  docker ps -a --filter "name=^/${APP_NAME}$"
  if container_exists; then
    echo
    docker logs --tail 60 "$APP_NAME"
  fi
}

logs() {
  require_docker
  if ! container_exists; then
    echo "Container $APP_NAME does not exist." >&2
    exit 1
  fi
  docker logs -f "$APP_NAME"
}

restart() {
  require_docker
  if ! container_exists; then
    echo "Container $APP_NAME does not exist; deploying instead."
    deploy
    return
  fi
  docker restart "$APP_NAME" >/dev/null
  echo "Restarted $APP_NAME."
}

command="${1:-deploy}"
case "$command" in
  deploy)
    deploy
    ;;
  update)
    pull_latest_if_possible
    deploy
    ;;
  clean)
    clean
    ;;
  redeploy)
    clean
    deploy
    ;;
  restart)
    restart
    ;;
  status)
    status
    ;;
  logs)
    logs
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $command" >&2
    usage
    exit 1
    ;;
esac
