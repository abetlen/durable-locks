# Kubernetes

The Kind overlay runs RustFS and one celld node for local development.
RustFS uses persistent local-path storage, while celld treats its local working directory as disposable and restores Durable Object state from RustFS.

## Requirements

- Docker with a running daemon.
- Node.js 24 with npm.
- A current `kubectl` configured for the local Kind cluster.
- The host routes installed by `~/Documents/kind.local/scripts/kind-network`.
- The `standard` StorageClass provided by Kind's local-path provisioner.
- A node named `kind-worker`, as configured by `~/Documents/kind.local/kind-config.yaml`.

## Deploy

```sh
./k8s/deploy.sh
```

The script applies the Kustomize overlay, waits for RustFS, creates the S3 bucket, bundles and deploys the Worker from the host, and restarts celld on the committed Worker version.
The one-shot Docker containers use host networking to reach the RustFS ClusterIP through the routes installed by `kind.local`.

Forward the Worker API to the host:

```sh
kubectl -n durable-locks port-forward service/celld 8080:8080
```

The API is then available at <http://127.0.0.1:8080>, with Swagger UI at <http://127.0.0.1:8080/docs>.

The in-cluster endpoints are:

- Worker API: `http://celld.durable-locks.svc.cluster.local:8080`.
- RustFS S3 API: `http://rustfs.durable-locks.svc.cluster.local:9000`.
- RustFS console: `http://rustfs.durable-locks.svc.cluster.local:9001`.

The RustFS development credentials are `durable-locks` and `durable-locks-secret`.

## Redeploy the Worker

Run the same deployment command after changing the Worker:

```sh
./k8s/deploy.sh
```

The script only restarts celld after `celld deploy` commits the new Worker version successfully.

## Inspect

```sh
kubectl -n durable-locks get deployment,pod,service,pvc
kubectl get pv
```

The overlay pins RustFS to `kind-worker`, whose local-path storage is mounted from `~/Documents/kind.local/volumes/worker`.
Deleting the RustFS Pod does not delete its PVC, and the replacement mounts the same data.
Celld uses an `emptyDir`, so replacing its Pod discards the local working set and restores cells from RustFS when they are next requested.

## Remove

```sh
kubectl delete -k k8s/overlays/kind
```

Deleting the overlay deletes the RustFS PVC, and the StorageClass reclaim policy then removes the provisioned directory and its data.
Deleting and recreating the Kind cluster also loses the Kubernetes PV and PVC records, so files left in the host-mounted directory are not automatically reattached.
