#!/usr/bin/env bash

set -Eeuo pipefail

CELLD_PORT="${CELLD_PORT:-8080}"
API_BASE="http://127.0.0.1:${CELLD_PORT}/api/v1"
CREATED_LOCK_IDS=()
CURL_AUTH=()

if [ -n "${API_TOKEN:-}" ]; then
  CURL_AUTH=(--header "authorization: Bearer ${API_TOKEN}")
fi

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'ok: %s\n' "$*"
}

request() {
  curl --fail --silent --show-error "${CURL_AUTH[@]}" "$@"
}

json_field() {
  node -e 'const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"))[process.argv[1]]; if (typeof value !== "string" && typeof value !== "number") process.exit(1); process.stdout.write(String(value));' "$1"
}

assert_equal() {
  [ "$1" = "$2" ] || die "$3"
}

cleanup() {
  for lock_id in "${CREATED_LOCK_IDS[@]}"; do
    curl --silent "${CURL_AUTH[@]}" --request DELETE --output /dev/null "${API_BASE}/locks/${lock_id}" || true
  done
}

command -v curl >/dev/null 2>&1 || die "curl is required."
command -v node >/dev/null 2>&1 || die "Node.js is required."
trap cleanup EXIT

request --retry 12 --retry-delay 1 --retry-connrefused --output /dev/null "http://127.0.0.1:${CELLD_PORT}/health"

lock_name="res-test-$(date +%s)-$$"
create_payload="$(printf '{"name":"%s","max_ttl_seconds":60,"metadata":{"test":"integration"}}' "$lock_name")"
lock_response="$(request --request POST --header 'content-type: application/json' --data "$create_payload" "${API_BASE}/locks")"
lock_id="$(printf '%s' "$lock_response" | json_field id)"
CREATED_LOCK_IDS+=("$lock_id")
assert_equal "$(printf '%s' "$lock_response" | json_field epoch)" "0" "A new lock did not begin at epoch zero."

replayed_lock_response="$(request --request POST --header 'content-type: application/json' --data "$create_payload" "${API_BASE}/locks")"
assert_equal "$(printf '%s' "$replayed_lock_response" | json_field id)" "$lock_id" "The create replay returned a different lock ID."
pass "lock creation is idempotent"

lease_name="example-lease-$(date +%s)-$$"
lease_payload="$(printf '{"name":"%s","ttl_seconds":30}' "$lease_name")"
lease_response="$(request --request POST --header 'content-type: application/json' --data "$lease_payload" "${API_BASE}/locks/${lock_id}/acquire")"
replayed_lease_response="$(request --request POST --header 'content-type: application/json' --data "$lease_payload" "${API_BASE}/locks/${lock_id}/acquire")"
lease_id="$(printf '%s' "$lease_response" | json_field id)"
assert_equal "$(printf '%s' "$lease_response" | json_field epoch)" "1" "The first lease did not receive epoch one."
assert_equal "$(printf '%s' "$replayed_lease_response" | json_field id)" "$lease_id" "The acquisition replay returned a different lease ID."
assert_equal "$(printf '%s' "$replayed_lease_response" | json_field fencing_token)" "$(printf '%s' "$lease_response" | json_field fencing_token)" "The acquisition replay returned a different fencing token."
pass "named acquisition replay preserves the lease and fencing token"

jwks_response="$(request "${API_BASE}/locks/${lock_id}/jwks")"
printf '%s' "$jwks_response" | node -e 'const jwks = JSON.parse(require("node:fs").readFileSync(0, "utf8")); const key = jwks.keys?.[0]; if (jwks.keys?.length !== 1 || key?.kty !== "EC" || key?.crv !== "P-256" || key?.alg !== "ES256" || "d" in key) process.exit(1);' || die "The JWKS response is invalid or exposes private key material."
pass "JWKS exposes one ES256 public key"

request --request POST --header 'content-type: application/json' --data "{\"lease_id\":\"${lease_id}\"}" --output /dev/null "${API_BASE}/locks/${lock_id}/release"
next_lease_response="$(request --request POST --header 'content-type: application/json' --data "{\"name\":\"${lease_name}-next\",\"ttl_seconds\":30}" "${API_BASE}/locks/${lock_id}/acquire")"
next_lease_id="$(printf '%s' "$next_lease_response" | json_field id)"
assert_equal "$(printf '%s' "$next_lease_response" | json_field epoch)" "2" "The second lease did not advance the fencing epoch."
request --request POST --header 'content-type: application/json' --data "{\"lease_id\":\"${next_lease_id}\"}" --output /dev/null "${API_BASE}/locks/${lock_id}/release"
pass "release allows the next acquisition to advance the epoch"

staging_response="$(request --request POST --header 'content-type: application/json' --data "{\"namespace\":\"staging\",\"name\":\"${lock_name}\",\"max_ttl_seconds\":60}" "${API_BASE}/locks")"
staging_lock_id="$(printf '%s' "$staging_response" | json_field id)"
CREATED_LOCK_IDS+=("$staging_lock_id")
[ "$staging_lock_id" != "$lock_id" ] || die "Two namespaces returned the same lock ID."
staging_list="$(request "${API_BASE}/locks?namespace=staging")"
LIST_JSON="$staging_list" LOCK_ID="$staging_lock_id" node -e 'const list = JSON.parse(process.env.LIST_JSON); if (list.namespace !== "staging" || !list.data.some((item) => item.id === process.env.LOCK_ID)) process.exit(1);' || die "The staging namespace list did not contain its lock."
pass "namespaces isolate lock names and listings"

delete_name="delete-test-$(date +%s)-$$"
delete_response="$(request --request POST --header 'content-type: application/json' --data "{\"name\":\"${delete_name}\",\"max_ttl_seconds\":60}" "${API_BASE}/locks")"
delete_lock_id="$(printf '%s' "$delete_response" | json_field id)"
CREATED_LOCK_IDS+=("$delete_lock_id")
request --request POST --header 'content-type: application/json' --data '{"name":"deletion-client","ttl_seconds":30}' --output /dev/null "${API_BASE}/locks/${delete_lock_id}/acquire"
delete_status="$(curl --silent "${CURL_AUTH[@]}" --request DELETE --output /dev/null --write-out '%{http_code}' "${API_BASE}/locks/${delete_lock_id}")"
assert_equal "$delete_status" "204" "Deleting a leased lock did not return HTTP 204."
read_status="$(curl --silent "${CURL_AUTH[@]}" --output /dev/null --write-out '%{http_code}' "${API_BASE}/locks/${delete_lock_id}")"
assert_equal "$read_status" "404" "Reading a deleted lock did not return HTTP 404."

recreated_response="$(request --request POST --header 'content-type: application/json' --data "{\"name\":\"${delete_name}\",\"max_ttl_seconds\":60}" "${API_BASE}/locks")"
recreated_lock_id="$(printf '%s' "$recreated_response" | json_field id)"
CREATED_LOCK_IDS+=("$recreated_lock_id")
[ "$recreated_lock_id" != "$delete_lock_id" ] || die "Recreating a deleted name reused its lock ID."
assert_equal "$(printf '%s' "$recreated_response" | json_field epoch)" "0" "The recreated lock did not begin at epoch zero."
pass "deletion permits recreation with a new lock identity"

pass "all integration checks passed"
