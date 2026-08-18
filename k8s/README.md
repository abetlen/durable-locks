# Kubernetes

The Kind overlay runs one standalone RustFS instance backed by the cluster's `standard` local-path StorageClass.
It is intended for local development and is not a highly available RustFS deployment.

## Requirements

- A current `kubectl` configured for the local Kind cluster.
- The `standard` StorageClass provided by Kind's local-path provisioner.
- A node named `kind-worker`, as configured by `~/Documents/kind.local/kind-config.yaml`.

## Deploy

```sh
kubectl apply -k k8s/overlays/kind
kubectl -n durable-locks rollout status deployment/rustfs --timeout=120s
```

The in-cluster endpoints are `http://rustfs.durable-locks.svc.cluster.local:9000` for S3 and `http://rustfs.durable-locks.svc.cluster.local:9001` for the console.

Forward both services to the host when local access is needed:

```sh
kubectl -n durable-locks port-forward service/rustfs 9000:9000 9001:9001
```

The development credentials are `durable-locks` and `durable-locks-secret`.

## Inspect

```sh
kubectl -n durable-locks get deployment,pod,service,pvc
kubectl get pv
```

The overlay pins RustFS to `kind-worker`, whose local-path storage is mounted from `~/Documents/kind.local/volumes/worker`.
Deleting the RustFS Pod does not delete the PVC, and its replacement mounts the same data.

## Remove

```sh
kubectl delete -k k8s/overlays/kind
```

Deleting the overlay deletes its PVC, and the StorageClass reclaim policy then removes the provisioned directory and its data.
Deleting and recreating the Kind cluster also loses the Kubernetes PV and PVC records, so files left in the host-mounted directory are not automatically reattached.
