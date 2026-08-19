<h1 align="center">Durable Locks</h1>

<p align="center"><strong>Distributed locking using durable objects.</strong></p>

<p align="center">
  <a href="https://github.com/abetlen/durable-locks/actions/workflows/checks.yml"><img alt="Checks" src="https://github.com/abetlen/durable-locks/actions/workflows/checks.yml/badge.svg"></a>
  <a href="./LICENSE.md"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white"></a>
</p>

A TypeScript reference implementation of [fencing-based distributed locks](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) built on top of durable objects.
It runs workers locally using [celld](https://github.com/denoland/celld) and persists Durable Object state to [RustFS](https://github.com/rustfs/rustfs) S3-compatible bucket.
Each worker exposes a [Hono](https://hono.dev) REST API with generated OpenAPI documentation.

> [!IMPORTANT]
> This repository is designed for local exploration and as a foundation for further development.
> The included environment uses fixed development credentials and is not a production deployment.

## Overview

- One independent SQLite-backed Durable Object per lock.
- Atomic, monotonically increasing fencing epochs.
- ES256-signed JWT fencing tokens with a per-lock JWKS endpoint.
- OIDC authentication with action scopes and resource grants.

## Quick start

### Requirements

- Docker to run celld and RustFS
- Node.js 24 with npm
- curl

### Start the environment

```sh
npm ci
./local.sh start
./local.sh test
```

The local services are then available at:

- API: <http://127.0.0.1:8080>
- Swagger UI: <http://127.0.0.1:8080/docs>
- OpenAPI document: <http://127.0.0.1:8080/openapi.json>
- RustFS S3 API: <http://127.0.0.1:9000>
- RustFS console: <http://127.0.0.1:9001>

The RustFS console credentials are `durable-locks` and `durable-locks-secret`.

### Kubernetes

The Kind overlays support RustFS by default and SeaweedFS as an alternative S3 backend.

Deploy with RustFS:

```sh
./k8s/deploy.sh
```

Deploy the independent SeaweedFS environment:

```sh
./k8s/deploy.sh seaweedfs
```

The RustFS environment uses the `durable-locks` namespace, while the SeaweedFS environment uses `durable-locks-seaweedfs` so both can run safely on the same cluster.
Each command applies its Kustomize overlay, deploys the Worker to the selected object store, and restarts its celld node.

## Try the API

Create a lock:

```sh
curl --request POST \
  --header 'content-type: application/json' \
  --data '{
    "name": "res-12345",
    "max_ttl_seconds": 300,
    "metadata": {
      "region": "us-west",
      "service": "billing"
    }
  }' \
  http://127.0.0.1:8080/api/v1/locks
```

The response begins at fencing epoch `0` and has no active lease:

```json
{
  "id": "lck-0123456789abcdef0123456789abcdef",
  "object": "lock",
  "name": "res-12345",
  "namespace": "default",
  "max_ttl_seconds": 300,
  "metadata": {
    "region": "us-west",
    "service": "billing"
  },
  "created_at": 1786928000,
  "epoch": 0,
  "lease": null
}
```

Acquire a lease:

```sh
LOCK_ID='lck-0123456789abcdef0123456789abcdef'

curl --request POST \
  --header 'content-type: application/json' \
  --data '{
    "name": "worker-7-job-123-attempt-1",
    "ttl_seconds": 30
  }' \
  "http://127.0.0.1:8080/api/v1/locks/${LOCK_ID}/acquire"
```

The lease advances the epoch and includes a signed fencing token:

```json
{
  "id": "lse-0123456789abcdef0123456789abcdef",
  "object": "lock_lease",
  "lock_id": "lck-0123456789abcdef0123456789abcdef",
  "name": "worker-7-job-123-attempt-1",
  "epoch": 1,
  "ttl_seconds": 30,
  "acquired_at": 1786928000,
  "expires_at": 1786928030,
  "fencing_token": "eyJ..."
}
```

## Architecture

Each namespace has one `LockNamespace` Durable Object that maps idempotent names to generated `lck-…` identifiers and supports listing and metadata filtering.
Each generated identifier addresses an independent `Lock` Durable Object containing the immutable lock configuration, current fencing epoch, active lease, and signing key.
Both Durable Object classes initialize their SQLite schemas inside `blockConcurrencyWhile()` before serving requests.

Locks begin at epoch `0`.
Every successful acquisition atomically advances the epoch and stores at most one active lease on the lock's singleton configuration row.
Named acquisition retries return the original lease and exact fencing token while that lease remains active.
Random lease identifiers prevent a stale client from releasing a newer client's lease.
Expired lease state is cleared during normal requests, so expiration does not require an alarm.

## Fencing model

A lease alone cannot prevent a paused client from resuming after its lease expires.
The API therefore returns a signed JWT containing the lock identity, lease identity, expiration, and monotonically increasing epoch.

Each lock owns one permanent ES256 signing key.
The private key remains inside the lock Durable Object, while the public key is available from the lock's immutable JWKS endpoint.

The protected resource must:

1. Fetch the public key from the expected lock's trusted JWKS endpoint.
2. Verify the fencing token's signature, expiration, issuer, lock identity, and claims.
3. Atomically reject epochs lower than the highest epoch it has already accepted.
4. Never trust an unsigned epoch or a key URL supplied by the caller.

Early release does not revoke an issued JWT.
The token remains cryptographically valid until its original expiration or until a newer epoch supersedes it at the protected resource.

## API reference

The generated OpenAPI document and interactive Swagger UI are the canonical request and response reference.

### Locks

- `GET /api/v1/locks` returns a cursor-paginated, newest-first list from the selected namespace.
- `POST /api/v1/locks` idempotently creates a named lock at epoch `0`.
- `GET /api/v1/locks/:id` returns a lock and its current active lease.
- `DELETE /api/v1/locks/:id` permanently deletes a lock and any active lease.

### Leases and keys

- `POST /api/v1/locks/:id/acquire` acquires or idempotently replays a named lease.
- `POST /api/v1/locks/:id/release` idempotently releases a matching lease identifier.
- `GET /api/v1/locks/:id/jwks` returns the immutable public key used to verify fencing tokens.

## Namespaces, metadata, and pagination

Requests may select a namespace explicitly or omit it to use `DEFAULT_LOCK_NAMESPACE`, which itself falls back to `default`.
Lock names are unique within a namespace and act as idempotency keys during creation.
Metadata is immutable and is returned by direct reads and list operations.

List metadata uses deep-object query parameters:

```text
/api/v1/locks?metadata%5Bregion%5D=us-west
```

List requests accept a `limit` from `1` through `100` and an opaque namespace-bound `cursor` returned by the previous page.
List responses include the resolved namespace once at the envelope level.
Lock TTLs cannot exceed the immutable maximum selected during creation or the service-level maximum of one hour.

## OIDC authentication

OIDC authentication is disabled when all OIDC Worker variables are absent.
Once any OIDC setting is present, incomplete or invalid configuration fails closed with HTTP `503` on protected routes.

Add the following variables to `vars` in `src/wrangler.jsonc`:

```jsonc
{
  "OIDC_ISSUER": "https://identity.example.com/",
  "OIDC_AUDIENCE": "https://locks.example.com",
  "OIDC_JWKS_URL": "https://identity.example.com/.well-known/jwks.json",
  "OIDC_GRANTS_CLAIM": "https://locks.example.com/grants",
  "OIDC_ALGORITHMS": "RS256"
}
```

`OIDC_ALGORITHMS` is optional and defaults to `RS256`.
Clients must present JWT access tokens minted for `OIDC_AUDIENCE`, not OIDC ID tokens.
The API verifies the signature, issuer, audience, time claims, and configured asymmetric algorithm against the deployment's fixed JWKS URL.

### Action scopes

The API accepts `scope` as a space-separated string and `scp` as either a string or array.

- `locks:read` permits listing and reading locks.
- `locks:write` permits creating locks and acquiring or releasing leases.
- `locks:admin` permits deleting locks.

Scopes are independent, so `locks:admin` does not imply `locks:read` or `locks:write`.

### Metadata grants

Set `OIDC_GRANTS_CLAIM` to the claim containing namespace-bound metadata selectors:

```json
{
  "https://locks.example.com/grants": [
    {
      "namespace": "team-a",
      "metadata": {
        "tenant": "tnt-123",
        "project": "billing"
      }
    },
    {
      "namespace": "shared",
      "metadata": {
        "owner": "payments"
      }
    }
  ]
}
```

Multiple grants use OR semantics, while metadata pairs within one grant use AND semantics.
Every metadata key is treated uniformly, and there are no reserved authorization metadata keys.
Omitting `metadata` or using an empty object grants access to every lock in that grant's namespace.

Resource grants are enforced during creation, server-side listing, and direct lock operations.
List pagination only counts locks matching at least one grant.
An inaccessible direct lock identifier returns HTTP `404` to limit cross-namespace probing.
The `*` namespace grant is only honored when the token also has `locks:admin`, and its metadata selectors still apply.

The health, documentation, OpenAPI, and per-lock fencing JWKS endpoints remain public.
Swagger UI exposes an `oidcBearer` authorization input for deployments that enable OIDC.

Run the integration suite with an access token by setting `API_TOKEN`:

```sh
API_TOKEN='eyJ…' ./local.sh test
```

## Deletion and lock identity

Deleting a lock removes its namespace registration, SQLite state, active lease, and private signing key.
Deletion cannot revoke fencing tokens that were already issued, and those tokens remain valid until their original expiration.

Deletion is an administrative operation that should only occur after every client using the lock has stopped.
Recreating the same namespace and name generates a new lock identifier, signing key, and epoch sequence.
Protected resources must treat the recreated lock as a new identity and retain their previous fencing state until they are atomically reconfigured to trust the replacement.

## Development

Run the static checks used by CI:

```sh
npm run lint
npm run typecheck
npm run build
```

Manage the local environment with:

```sh
./local.sh start
./local.sh test
./local.sh status
./local.sh logs
./local.sh stop
./local.sh reset
```

Running `start` again bundles and deploys the Worker before recreating the celld container.
`stop` retains the named Docker volumes, while `reset` removes the containers, network, and all local data.

Override the default host ports with environment variables:

```sh
CELLD_PORT=8180 \
RUSTFS_API_PORT=9100 \
RUSTFS_CONSOLE_PORT=9101 \
./local.sh start
```

The local environment does not migrate Durable Object storage created by incompatible source revisions.
Run `./local.sh reset` after an incompatible schema change.

## Contributing

Issues and pull requests are welcome.
Run linting, type-checking, and the local integration suite before submitting a change.

## License

Durable Locks is available under the [MIT License](./LICENSE.md).
