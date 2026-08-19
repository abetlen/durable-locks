#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBE_CONTEXT="${KUBE_CONTEXT:-kind-kind}"
NAMESPACE="durable-locks"
STORAGE_BACKEND="${1:-rustfs}"

case "$STORAGE_BACKEND" in
  rustfs)
    OVERLAY="$ROOT_DIR/k8s/overlays/kind-rustfs"
    STORAGE_DEPLOYMENT="rustfs"
    S3_SERVICE="s3-rustfs"
    ;;
  seaweedfs)
    OVERLAY="$ROOT_DIR/k8s/overlays/kind-seaweedfs"
    STORAGE_DEPLOYMENT="seaweedfs"
    S3_SERVICE="s3-seaweedfs"
    ;;
  *)
    printf 'error: storage backend must be rustfs or seaweedfs.\n' >&2
    exit 1
    ;;
esac

if (($# > 1)); then
  printf 'error: usage: %s [rustfs|seaweedfs]\n' "$0" >&2
  exit 1
fi

CELLD_IMAGE="${CELLD_IMAGE:-ghcr.io/denoland/celld:0.2.1}"
S3_CLI_IMAGE="${S3_CLI_IMAGE:-rustfs/rc:v0.1.31}"

BUCKET="durable-locks"
AWS_REGION="us-east-1"
ACCESS_KEY="admin"
SECRET_KEY="admin"

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_tools() {
  command -v docker >/dev/null 2>&1 || die "Docker is required."
  command -v kubectl >/dev/null 2>&1 || die "kubectl is required."
  command -v npm >/dev/null 2>&1 || die "npm is required."
  command -v curl >/dev/null 2>&1 || die "curl is required."
  docker info >/dev/null 2>&1 || die "The Docker daemon is not available."
  kubectl --context "$KUBE_CONTEXT" cluster-info >/dev/null 2>&1 || die "Kubernetes context '$KUBE_CONTEXT' is not available."
}

apply_manifests() {
  say "Applying the $STORAGE_BACKEND Kind overlay"
  kubectl --context "$KUBE_CONTEXT" apply --kustomize "$OVERLAY"
  kubectl --context "$KUBE_CONTEXT" --namespace "$NAMESPACE" \
    rollout status "deployment/$STORAGE_DEPLOYMENT" --timeout=180s
}

s3_endpoint() {
  local service_ip
  service_ip="$(
    kubectl --context "$KUBE_CONTEXT" --namespace "$NAMESPACE" \
      get service "$S3_SERVICE" --output jsonpath='{.spec.clusterIP}'
  )"
  if [ -z "$service_ip" ] || [ "$service_ip" = "None" ]; then
    die "The S3 service has no ClusterIP."
  fi
  printf 'http://%s:9000' "$service_ip"
}

wait_for_s3_route() {
  local endpoint="$1"
  local attempts=30
  while ((attempts > 0)); do
    if curl --connect-timeout 1 --max-time 2 --silent --output /dev/null "$endpoint/"; then
      return
    fi
    sleep 1
    attempts=$((attempts - 1))
  done
  die "The S3 service is not reachable from the host at $endpoint."
}

create_bucket() {
  local endpoint="$1"
  say "Creating the s3://${BUCKET} bucket if needed"
  docker run --rm \
    --network host \
    --entrypoint /bin/sh \
    --env RUSTFS_ENDPOINT="$endpoint" \
    --env RUSTFS_ACCESS_KEY="$ACCESS_KEY" \
    --env RUSTFS_SECRET_KEY="$SECRET_KEY" \
    --env RUSTFS_BUCKET="$BUCKET" \
    "$S3_CLI_IMAGE" \
    -eu -c '
      rc alias set local "$RUSTFS_ENDPOINT" "$RUSTFS_ACCESS_KEY" "$RUSTFS_SECRET_KEY" --bucket-lookup path --quiet
      rc bucket create --ignore-existing "local/$RUSTFS_BUCKET"
    '
}

build_worker() {
  say "Bundling the TypeScript Worker"
  npm --prefix "$ROOT_DIR" run build
}

deploy_worker() {
  local endpoint="$1"
  say "Deploying the Worker to $STORAGE_BACKEND"
  docker run --rm \
    --network host \
    --env AWS_ACCESS_KEY_ID="$ACCESS_KEY" \
    --env AWS_SECRET_ACCESS_KEY="$SECRET_KEY" \
    --env AWS_REGION="$AWS_REGION" \
    --volume "$ROOT_DIR/src:/src:ro" \
    "$CELLD_IMAGE" \
    deploy /src \
    --bucket "s3://${BUCKET}" \
    --endpoint "$endpoint" \
    --region "$AWS_REGION"
}

restart_celld() {
  say "Restarting celld to load the deployed Worker"
  kubectl --context "$KUBE_CONTEXT" --namespace "$NAMESPACE" \
    rollout restart deployment/celld
  kubectl --context "$KUBE_CONTEXT" --namespace "$NAMESPACE" \
    rollout status deployment/celld --timeout=180s
}

main() {
  require_tools
  apply_manifests

  local endpoint
  endpoint="$(s3_endpoint)"
  wait_for_s3_route "$endpoint"
  create_bucket "$endpoint"
  build_worker
  deploy_worker "$endpoint"
  restart_celld

  say "Durable Locks is ready"
  printf 'Port forward: kubectl --context %s --namespace %s port-forward service/api 8080:80\n' "$KUBE_CONTEXT" "$NAMESPACE"
}

main "$@"
