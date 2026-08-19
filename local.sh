#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CELLD_IMAGE="${CELLD_IMAGE:-ghcr.io/denoland/celld:0.2.1}"
RUSTFS_IMAGE="${RUSTFS_IMAGE:-rustfs/rustfs:1.0.0-beta.12}"
RUSTFS_CLI_IMAGE="${RUSTFS_CLI_IMAGE:-rustfs/rc:v0.1.31}"

NETWORK="durable-locks"
RUSTFS_CONTAINER="durable-locks-rustfs"
CELLD_CONTAINER="durable-locks-celld"
RUSTFS_VOLUME="durable-locks-rustfs-data"
CELLD_VOLUME="durable-locks-state"

BUCKET="durable-locks"
AWS_REGION="us-east-1"
ACCESS_KEY="admin"
SECRET_KEY="admin"

CELLD_PORT="${CELLD_PORT:-8080}"
RUSTFS_API_PORT="${RUSTFS_API_PORT:-9000}"
RUSTFS_CONSOLE_PORT="${RUSTFS_CONSOLE_PORT:-9001}"
RUSTFS_ENDPOINT="http://rustfs:9000"

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is required."
  command -v curl >/dev/null 2>&1 || die "curl is required."
  docker info >/dev/null 2>&1 || die "The Docker daemon is not available."
}

require_build_tools() {
  command -v npm >/dev/null 2>&1 || die "npm is required; install Node.js and npm."
  [ -x "$ROOT_DIR/node_modules/.bin/esbuild" ] || die "Dependencies are missing; run 'npm install'."
}

container_exists() {
  docker container inspect "$1" >/dev/null 2>&1
}

container_running() {
  [ "$(docker container inspect --format '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]
}

wait_for_rustfs() {
  local attempts=60
  while ((attempts > 0)); do
    if curl --fail --silent --output /dev/null "http://127.0.0.1:${RUSTFS_API_PORT}/health"; then
      return
    fi
    if ! container_running "$RUSTFS_CONTAINER"; then
      docker logs "$RUSTFS_CONTAINER" >&2 || true
      die "RustFS stopped before becoming ready."
    fi
    sleep 1
    attempts=$((attempts - 1))
  done
  die "RustFS did not become ready within 60 seconds."
}

wait_for_celld() {
  local attempts=60
  while ((attempts > 0)); do
    if curl --fail --silent --output /dev/null "http://127.0.0.1:${CELLD_PORT}/health"; then
      return
    fi
    if ! container_running "$CELLD_CONTAINER"; then
      docker logs "$CELLD_CONTAINER" >&2 || true
      die "celld stopped before becoming ready."
    fi
    sleep 1
    attempts=$((attempts - 1))
  done
  die "celld did not become ready within 60 seconds."
}

run_rustfs_cli() {
  docker run --rm \
    --network "$NETWORK" \
    --entrypoint /bin/sh \
    -e RUSTFS_ENDPOINT="$RUSTFS_ENDPOINT" \
    -e RUSTFS_ACCESS_KEY="$ACCESS_KEY" \
    -e RUSTFS_SECRET_KEY="$SECRET_KEY" \
    "$RUSTFS_CLI_IMAGE" \
    -eu -c '
      rc alias set local "$RUSTFS_ENDPOINT" "$RUSTFS_ACCESS_KEY" "$RUSTFS_SECRET_KEY" --bucket-lookup path --quiet
      exec rc "$@"
    ' sh "$@"
}

start_rustfs() {
  say "Starting local RustFS"
  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
  docker volume inspect "$RUSTFS_VOLUME" >/dev/null 2>&1 || docker volume create "$RUSTFS_VOLUME" >/dev/null

  if container_exists "$RUSTFS_CONTAINER"; then
    docker rm --force "$RUSTFS_CONTAINER" >/dev/null
  fi

  docker run --detach \
    --name "$RUSTFS_CONTAINER" \
    --network "$NETWORK" \
    --network-alias rustfs \
    --publish "127.0.0.1:${RUSTFS_API_PORT}:9000" \
    --publish "127.0.0.1:${RUSTFS_CONSOLE_PORT}:9001" \
    --env RUSTFS_ACCESS_KEY="$ACCESS_KEY" \
    --env RUSTFS_SECRET_KEY="$SECRET_KEY" \
    --env RUSTFS_CONSOLE_ENABLE=true \
    --env RUSTFS_ADDRESS=0.0.0.0:9000 \
    --env RUSTFS_CONSOLE_ADDRESS=0.0.0.0:9001 \
    --volume "$RUSTFS_VOLUME:/data" \
    "$RUSTFS_IMAGE" >/dev/null

  wait_for_rustfs
}

create_bucket() {
  say "Creating the s3://${BUCKET} bucket if needed"
  run_rustfs_cli bucket create --ignore-existing "local/${BUCKET}"
}

build_worker() {
  require_build_tools
  say "Bundling the TypeScript Worker with esbuild"
  npm --prefix "$ROOT_DIR" run build
}

deploy_worker() {
  build_worker
  say "Deploying the Durable Object Worker into RustFS"
  docker run --rm \
    --network "$NETWORK" \
    --env AWS_ACCESS_KEY_ID="$ACCESS_KEY" \
    --env AWS_SECRET_ACCESS_KEY="$SECRET_KEY" \
    --env AWS_REGION="$AWS_REGION" \
    --volume "$ROOT_DIR/src:/src:ro" \
    "$CELLD_IMAGE" \
    deploy /src \
    --bucket "s3://${BUCKET}" \
    --endpoint "$RUSTFS_ENDPOINT" \
    --region "$AWS_REGION"
}

start_celld() {
  say "Starting celld"
  if container_exists "$CELLD_CONTAINER"; then
    docker rm --force "$CELLD_CONTAINER" >/dev/null
  fi
  docker volume inspect "$CELLD_VOLUME" >/dev/null 2>&1 || docker volume create "$CELLD_VOLUME" >/dev/null

  docker run --detach \
    --name "$CELLD_CONTAINER" \
    --network "$NETWORK" \
    --network-alias celld \
    --publish "127.0.0.1:${CELLD_PORT}:8080" \
    --env AWS_ACCESS_KEY_ID="$ACCESS_KEY" \
    --env AWS_SECRET_ACCESS_KEY="$SECRET_KEY" \
    --env AWS_REGION="$AWS_REGION" \
    --env CELLD_WATCH=/var/lib/celld/state \
    --volume "$CELLD_VOLUME:/var/lib/celld" \
    "$CELLD_IMAGE" \
    --bucket "s3://${BUCKET}" \
    --endpoint "$RUSTFS_ENDPOINT" \
    --region "$AWS_REGION" \
    --listen 0.0.0.0:8080 \
    --internal-listen 0.0.0.0:8081 \
    --advertise celld:8081 >/dev/null

  wait_for_celld
}

start() {
  require_docker
  start_rustfs
  create_bucket
  deploy_worker
  start_celld
  say "Local environment is ready"
  printf 'Worker:         http://127.0.0.1:%s\n' "$CELLD_PORT"
  printf 'RustFS console: http://127.0.0.1:%s\n' "$RUSTFS_CONSOLE_PORT"
  printf 'Next:           %s test\n' "$0"
}

test_api() {
  require_docker
  container_running "$CELLD_CONTAINER" || die "The local environment is not running; run '$0 start' first."
  CELLD_PORT="$CELLD_PORT" "$ROOT_DIR/scripts/test-api.sh"
}

status() {
  require_docker
  say "Containers"
  docker ps --all \
    --filter "name=^/${RUSTFS_CONTAINER}$" \
    --filter "name=^/${CELLD_CONTAINER}$" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

  if container_running "$RUSTFS_CONTAINER"; then
    say "Objects in RustFS"
    run_rustfs_cli object list --recursive "local/${BUCKET}" || true
  fi
}

logs() {
  require_docker
  container_exists "$RUSTFS_CONTAINER" || die "The local environment has not been started."
  container_exists "$CELLD_CONTAINER" || die "The celld container does not exist."
  docker logs --follow "$RUSTFS_CONTAINER" &
  local rustfs_logs_pid=$!
  trap 'kill "$rustfs_logs_pid" 2>/dev/null || true' EXIT INT TERM
  docker logs --follow "$CELLD_CONTAINER"
}

stop() {
  require_docker
  say "Stopping local containers and retaining data"
  if container_exists "$CELLD_CONTAINER"; then
    docker stop "$CELLD_CONTAINER" >/dev/null || true
  fi
  if container_exists "$RUSTFS_CONTAINER"; then
    docker stop "$RUSTFS_CONTAINER" >/dev/null || true
  fi
}

reset() {
  require_docker
  say "Removing local containers and all local data"
  if container_exists "$CELLD_CONTAINER"; then
    docker rm --force "$CELLD_CONTAINER" >/dev/null
  fi
  if container_exists "$RUSTFS_CONTAINER"; then
    docker rm --force "$RUSTFS_CONTAINER" >/dev/null
  fi
  docker volume rm "$CELLD_VOLUME" "$RUSTFS_VOLUME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}

usage() {
  cat <<EOF
Usage: $0 COMMAND

Commands:
  build    Bundle the TypeScript Worker with esbuild.
  start    Start RustFS, deploy the Worker, and start celld.
  test     Exercise namespaces, signed fencing tokens, replay, release, and deletion.
  status   Show the containers and RustFS bucket contents.
  logs     Follow RustFS and celld logs.
  stop     Stop containers but retain data.
  reset    Remove containers and all local data.
EOF
}

case "${1:-}" in
  build) build_worker ;;
  start) start ;;
  test) test_api ;;
  status) status ;;
  logs) logs ;;
  stop) stop ;;
  reset) reset ;;
  help | --help | -h | "") usage ;;
  *) usage >&2; exit 1 ;;
esac
