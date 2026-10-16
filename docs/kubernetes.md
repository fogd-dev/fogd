# Run the experimental Kubernetes qualification

M9a exercises fogd on an isolated local kind cluster. It deploys two supported apps
through the same scoped submission and approval flow as Docker. Kubernetes recovery
is not qualified yet; use disposable data. Actual remote host/storage/network failure
remains a separate M9 gate.

## Create and test a local cluster

Install the checkout's dependencies and use existing Docker, kind, kubectl, and
OpenSSL commands. The runner creates a new cluster only and keeps its kubeconfig,
certificates, and installation files inside `.fogd/`. Stop processes occupying the
localhost app/admin ports 8787/8788 before running:

```sh
node scripts/kubernetes-setup.mjs .fogd/m9demo
NODE_EXTRA_CA_CERTS="$PWD/.fogd/m9demo/certificate/ca.pem" \
  node scripts/kubernetes-smoke.mjs .fogd/m9demo .fogd/m9demo/certificate/server.pem
```

Setup builds and loads local images without publishing them. The smoke verifies the
named kind cluster before applying resources. It deploys accounts and notebook,
writes D1/R2/DO data, logs in through native Void auth, and replaces individual
replica/controller/gateway pods. PVC identities and image identities must match the
recorded evidence. The smoke requires an empty installation and stops its temporary
port forwards when finished. Inspect `.fogd/m9demo/evidence.json` for results.

To observe a worker outage after the smoke:

```sh
NODE_EXTRA_CA_CERTS="$PWD/.fogd/m9demo/certificate/ca.pem" \
  node scripts/kubernetes-node-observation.mjs .fogd/m9demo
```

This stops one local Docker node abruptly, samples availability, starts it again,
and verifies existing notebook data. Co-located MinIO, controller, or gateway pods
can make the installation unavailable. The observation records placement and results;
it does not claim a Kubernetes node restart proves disk or physical-host resilience.

## Render manifests for inspection

`fogd kube render` does not contact a cluster. Select a private installation file
with shared profile, TLS enabled, an empty legacy deploy token, admin/gateway/bucket
credentials, and `FOGD_KUBE_NAMESPACE`. Supply digest-pinned
`FOGD_KUBE_RUNTIME_IMAGE` and `FOGD_KUBE_MINIO_IMAGE`. The local kind drill instead
sets `FOGD_KUBE_LOCAL_IMAGES=1`, uses Never pull policy, and verifies loaded image IDs.

```sh
FOGD_ENV_FILE="$PWD/.fogd/kube.env" pnpm exec fogd kube render \
  .fogd/kube-render --cert /path/to/server-chain.pem --key /path/to/server-key.pem
```

The new output directory contains `namespace.json`, `manifests.json`, separate `secrets.json`,
`installation.env`, and `topology.json`. Protect the entire directory. The manifest
contains secret references; the secrets and installation files contain private
values. Kubernetes Secrets are not encrypted at rest by fogd. Applying these files
to a real cluster requires that operator's storage, network, image, DNS, and recovery
review; the local runner never applies to an existing cluster.

## Ownership and teardown

Each replica has a stable ClusterIP Service so pod IP changes do not require a
gateway configuration reload. Each fleet has two ordinal-based celld identities with individual PVCs and stable
headless-Service DNS. Those identities differ from the Compose replica names; do not
substitute Compose volumes for Kubernetes PVCs. Controller and MinIO each have one
writer. StatefulSets use OnDelete updates and retain claims. Updating a manifest does
not automatically replace these pods. Back up and plan upgrades before replacing
stateful pods manually; Kubernetes backup/restore is M9b work.

To stop this experimental installation while retaining its PVCs:

```sh
kubectl --kubeconfig "$PWD/.fogd/m9demo/kubeconfig" --context kind-fogd-m9demo \
  -n fogd-m9demo scale statefulset workerd controller --replicas=0
# Wait for both pods to terminate before stopping the fleets.
kubectl --kubeconfig "$PWD/.fogd/m9demo/kubeconfig" --context kind-fogd-m9demo \
  -n fogd-m9demo scale statefulset slot-1 slot-2 --replicas=0
# Wait for every fleet pod to terminate before stopping the bucket.
kubectl --kubeconfig "$PWD/.fogd/m9demo/kubeconfig" --context kind-fogd-m9demo \
  -n fogd-m9demo scale statefulset minio --replicas=0
```

Do not force-delete pods on an unavailable node: the old process may still hold its
identity and storage lease. Restore node access first. Deleting a PVC or namespace
can delete its underlying local-path data. `kind delete cluster` destroys the local
cluster's storage. The namespace has its own file so deleting `manifests.json` removes only workloads
and Services, retaining claims. Never delete `namespace.json` as routine teardown.
Deleting only workloads retains claims, but is not a backup.
`fogd backup` refuses the generated Kubernetes installation file before Docker calls.

Default kind networking does not enforce per-fleet isolation. Trusted pods can reach
celld directly and forge forwarding headers. This is weaker than Compose's separate
fleet networks. A real shared cluster needs an enforced and tested network policy.
Containers currently run as root with capabilities dropped. No application pod
receives a Kubernetes service-account token. Only app/admin ports
are forwarded locally; the manifests create ClusterIP Services, never public load
balancers. Native TLS protects public requests; private traffic remains HTTP.


The renderer preserves controller admission limits and celld/MinIO resource limits.
Compose-style memory suffixes such as `512m` become Kubernetes `512Mi`. Replica IDs
and hostnames are topology-owned ordinal Service names; Compose overrides do not
carry into the generated installation file. An external bucket endpoint is refused.
The kubelet's kind-import image label can vary; evidence verifies the node image's
config ID against Docker, rather than treating that display label as a stable digest.
