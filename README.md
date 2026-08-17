# Distributed Locking API

This project demonstrates time-leased distributed locks with fencing tokens on `celld` using a local RustFS S3-compatible bucket.

It uses TypeScript, Hono, OpenAPI, and esbuild for the Worker API.

The readable `local.sh` script runs the complete environment with plain Docker commands, so Docker Compose, a local Rust toolchain, and AWS tooling are not required.

The API integration checks live in `scripts/test-api.sh`, and `./local.sh test` delegates to that script.

The host prerequisites are Docker with a running daemon, `curl`, Node.js, and npm.

## Quick start

```sh
npm install
./local.sh start
./local.sh test
```

The services are available at:

- Worker: <http://127.0.0.1:8080>

- Swagger UI: <http://127.0.0.1:8080/docs>

- RustFS S3 API: <http://127.0.0.1:9000>

- RustFS console: <http://127.0.0.1:9001>

The RustFS console credentials are `distributed-locking-api` and `distributed-locking-api-secret`.

## How it works

Each lock is an independent SQLite-backed `Lock` Durable Object.

A separate `LockNamespace` Durable Object maps names to generated `lck-…` IDs within each namespace and supports listing and metadata filtering.

Requests can select a namespace explicitly or omit it to use the optional `DEFAULT_LOCK_NAMESPACE` Worker variable, which itself falls back to `default`.

Creating a lock explicitly calls its idempotent `init()` RPC with its immutable ID, name, namespace, maximum TTL, metadata, and creation time.

The SQL-backed Durable Objects initialize their schemas inside `blockConcurrencyWhile()` before handling requests.

Locks begin at epoch `0`, and every successful lease acquisition atomically advances the epoch to produce a fencing token.

Each lock owns one permanent ES256 signing key and returns its epoch inside a signed JWT so callers cannot forge a higher fencing value.

The private key remains in the lock Durable Object, while the immutable public key is available through the lock's standard JWKS endpoint.

Named acquisition retries return the same lease without advancing the epoch while that lease remains active.

Named acquisition retries also return the exact same stored fencing token.

Random lease IDs prevent stale callers from releasing a newer lease.

Lease expiration is request-driven and does not require alarms.

Each lock stores at most one active lease directly on its singleton configuration row.

Released and expired active lease state is cleared during normal requests, while the fencing epoch is retained permanently and never resets.

The protected resource must atomically reject fencing epochs lower than the highest epoch it has already accepted, because a paused client may resume after its lease expires.

The protected resource must verify the JWT against the expected lock's trusted JWKS endpoint and must never accept an unsigned epoch or a key URL supplied by the caller.

Early release does not revoke an issued JWT, so it remains valid until its original expiration or until a newer fencing epoch supersedes it at the protected resource.

Lock deletion removes both the namespace registration and the lock's durable state, including any active lease.

Deleting a lock cannot revoke an already issued fencing token, which remains cryptographically valid until its original expiration.

Deletion is an administrative operation that must only be used after every client of the lock has been stopped.

Recreating the same namespace and name produces a new lock ID, signing key, and epoch sequence, so protected resources must treat it as a completely new lock identity.

Protected resources must retain their existing fencing state until they are atomically reconfigured to trust the replacement lock ID and JWKS.

## API

- `GET /api/v1/locks` returns a cursor-paginated, newest-first list from the namespace selected by its optional `namespace` query parameter.

- `POST /api/v1/locks` accepts an optional `namespace` alongside `{ "name": "res-12345", "max_ttl_seconds": 300 }` and idempotently creates a lock at epoch `0`.

- `GET /api/v1/locks/:id` reads a lock and its current active lease directly from the lock Durable Object.

- `DELETE /api/v1/locks/:id` deletes a lock and any active lease as an administrative operation.

- `POST /api/v1/locks/:id/acquire` accepts `{ "name": "worker-7-job-123-attempt-1", "ttl_seconds": 30 }` and returns a lease with a new fencing epoch and signed `fencing_token` JWT.

- `POST /api/v1/locks/:id/release` accepts `{ "lease_id": "lse-…" }` and idempotently releases that lease.

- `GET /api/v1/locks/:id/jwks` returns the immutable ES256 public key used to verify that lock's fencing tokens.

- `GET /openapi.json` returns the generated OpenAPI 3.0 document.

- `GET /docs` serves Swagger UI for the generated document.

- `GET /health` provides the readiness check used by the local script.

Lock metadata is immutable and is returned by direct reads and list operations.

List metadata can be filtered with deep-object query parameters such as `/api/v1/locks?metadata%5Bregion%5D=us-west`.

List responses identify the resolved namespace once at the envelope level.

List requests accept a `limit` from `1` through `100` and an opaque namespace-bound `cursor` returned by the previous page.

The `DEFAULT_LOCK_NAMESPACE` value can be changed or removed from `src/wrangler.jsonc`, and omitting it preserves the built-in `default` fallback.

Lock TTLs cannot exceed the immutable maximum configured during creation, and the API applies a service-level maximum of one hour.

## OIDC authentication

OIDC authentication is disabled by default and remains disabled when all OIDC Worker variables are absent.

Enable it for the entire deployment by adding the following variables to the `vars` object in `src/wrangler.jsonc`:

```jsonc
{
  "OIDC_ISSUER": "https://identity.example.com/",
  "OIDC_AUDIENCE": "https://locks.example.com",
  "OIDC_JWKS_URL": "https://identity.example.com/.well-known/jwks.json",
  "OIDC_NAMESPACE_CLAIM": "https://locks.example.com/namespaces",
  "OIDC_ALGORITHMS": "RS256"
}
```

`OIDC_ALGORITHMS` is optional and defaults to `RS256`, while every other OIDC variable above is required once authentication is enabled.

`OIDC_NAMESPACE_CLAIM` selects the simple namespace-only authorization mode.

To authorize particular metadata key-value pairs instead, replace `OIDC_NAMESPACE_CLAIM` with a grants claim:

```jsonc
{
  "OIDC_GRANTS_CLAIM": "https://locks.example.com/grants"
}
```

Exactly one of `OIDC_NAMESPACE_CLAIM` or `OIDC_GRANTS_CLAIM` must be configured.

A partial or invalid OIDC configuration fails closed with HTTP `503` on protected routes.

The API validates each access token's signature, issuer, audience, time claims, and configured asymmetric signing algorithm against the fixed deployment JWKS URL.

Clients must send JWT access tokens minted for `OIDC_AUDIENCE`, not OIDC ID tokens.

The deployment must configure its provider to place the following authorization claims in access tokens:

- `scope` as a space-separated string or `scp` as either a string or array.

  - `locks:read` permits listing and reading locks.

  - `locks:write` permits creating locks and acquiring or releasing leases.

  - `locks:admin` permits deleting locks.

- One access claim in the configured mode.

  - Namespace mode expects the claim named by `OIDC_NAMESPACE_CLAIM` to contain an array or space-separated string of namespace names such as `["team-a", "staging"]`.

  - Grants mode expects the claim named by `OIDC_GRANTS_CLAIM` to contain namespace-bound grants such as:

    ```json
    [
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
    ```

Multiple grants are OR conditions, while the metadata pairs within each grant are AND conditions.

Every metadata key is treated uniformly, and there are no reserved authorization metadata keys.

Omitting `metadata` or using an empty object grants access to every lock in that grant's namespace.

The action scopes are independent, so `locks:admin` does not implicitly grant `locks:read` or `locks:write`.

Resource grants are enforced when creating locks, listing locks, and performing direct lock-ID operations.

List authorization is applied inside the namespace query, so pagination only counts locks matching at least one grant.

An inaccessible direct lock ID returns HTTP `404` so callers cannot probe locks in other namespaces.

The `*` namespace grant is only honored when the token also has `locks:admin`, and any metadata selectors on that grant still apply.

The health, documentation, OpenAPI, and per-lock fencing JWKS endpoints remain public.

Swagger UI exposes an `oidcBearer` authorization input for deployments that enable OIDC.

Run the integration checks against an authenticated deployment by supplying an access token with all three scopes and grants for the namespaces exercised by the script:

```sh
API_TOKEN='eyJ…' ./local.sh test
```

## Commands

```sh
./local.sh build    # Bundle the TypeScript Worker with esbuild.
./local.sh start    # Start RustFS, deploy the Worker, and start celld.
./local.sh test     # Exercise namespaces, signed fencing tokens, replay, release, and deletion.
./local.sh status   # Show the containers and RustFS objects.
./local.sh logs     # Follow the RustFS and celld logs.
./local.sh stop     # Stop the containers while retaining their named volumes.
./local.sh reset    # Remove the containers, network, and all local data.
```

Running `start` again redeploys the Worker before recreating the `celld` container.

Use `CELLD_PORT`, `RUSTFS_API_PORT`, or `RUSTFS_CONSOLE_PORT` to change host ports when the defaults are occupied.

```sh
CELLD_PORT=8180 RUSTFS_API_PORT=9100 RUSTFS_CONSOLE_PORT=9101 ./local.sh start
```

This setup is intentionally local-only and uses fixed development credentials, so it is not a production deployment.

The demo does not migrate storage created by older source revisions, so use `./local.sh reset` after an incompatible schema change.
