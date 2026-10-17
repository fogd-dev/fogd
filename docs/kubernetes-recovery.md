# Recover a stopped local Kubernetes installation

This adapter covers fogd's experimental two-slot local kind topology with local-path
PVCs. It does not cover a remote cluster, external bucket, live backup, or arbitrary
StorageClass. Use the [Kubernetes setup guide](kubernetes.md) to create the fixture.
Keep the snapshot and generated private files on protected storage: they contain
app data, account sessions, deploy credentials, secret revisions, and TLS keys.

## Snapshot and restore

Use explicit kubeconfig/context arguments. No implicit current context is used:

```sh
pnpm exec fogd kube backup .fogd/m9demo/installation .fogd/m9demo-backup \
  --kubeconfig "$PWD/.fogd/m9demo/kubeconfig" --context kind-fogd-m9demo
pnpm exec fogd kube restore .fogd/m9demo-backup \
  --namespace fogd-m9demo-restored --output .fogd/m9demo-restored \
  --kubeconfig "$PWD/.fogd/m9demo/kubeconfig" --context kind-fogd-m9demo
```

Backup checks desired/live workload definitions, writer ownership, storage, and
running image identities before stopping anything. It stops gateway/controller,
then both fleets, then MinIO, waiting for each group to disappear. Read-only helper
pods archive every claim, and an independent in-pod checksum must match the received
stream. The source stays stopped. Do not run another operator mutation during backup.

Restore verifies files and image metadata before creating the target namespace.
An existing namespace is refused. Conflicting image tags are refused; missing exact
images can be loaded from the verified archive. New claims bind on selected worker
nodes, with fleet ordinals on different nodes. Empty-disk checks, numeric ownership,
fsync, and tar comparison precede the receipt. All restored writers remain stopped.

## Start the recovered installation

Set these values for the chosen target; the shell function only affects this shell:

```sh
export FOGD_KUBE_CONFIG="$PWD/.fogd/m9demo/kubeconfig"
export FOGD_KUBE_CONTEXT=kind-fogd-m9demo
export FOGD_KUBE_NAMESPACE=fogd-m9demo-restored
k() { kubectl --kubeconfig "$FOGD_KUBE_CONFIG" --context "$FOGD_KUBE_CONTEXT" -n "$FOGD_KUBE_NAMESPACE" "$@"; }
k scale statefulset/minio --replicas=1
k wait '--for=jsonpath={.status.readyReplicas}=1' statefulset/minio --timeout=180s
k scale statefulset/slot-1 statefulset/slot-2 --replicas=2
k scale statefulset/controller --replicas=1
k wait '--for=jsonpath={.status.readyReplicas}=2' statefulset/slot-1 statefulset/slot-2 --timeout=180s
k wait '--for=jsonpath={.status.readyReplicas}=1' statefulset/controller --timeout=180s
k scale statefulset/workerd --replicas=1
k wait '--for=jsonpath={.status.readyReplicas}=1' statefulset/workerd --timeout=180s
k apply -f .fogd/m9demo-restored/manifests.json
```

The final apply records the running desired configuration for later drift checks.
Use port forwards and the same private-CA trust as the source. The restored
installation.env provides admin settings for the CLI; select it with FOGD_ENV_FILE.
Certificates can expire while a snapshot is retained; renewal remains operator-owned.

## Failure and evidence

Only manifest.json marks a complete snapshot. started.json and stop.json describe an
attempt; neither makes partial archives usable. stop.json distinguishes observed
clean exits from nonzero or unobserved outcomes. A forced stop may require upstream
crash recovery, even when every archive is complete. The snapshot excludes writes
made after the source later restarts; no live recovery-point guarantee is claimed.

If a node becomes unreachable, backup waits for actual pod termination and then
fails. Never force-delete its pods to manufacture quiescence. Restore node access
first. The source may be partly stopped. Use the same ordered startup procedure for
its namespace and original manifest before a fresh backup to a new directory.
Automatic snapshot resumption and already-stopped source capture are unsupported.
Helpers and commands have a 15-minute ceiling; large-volume qualification is open.

No recovery command deletes a namespace or PVC. A failed restore retains its partial
namespace for inspection and refuses reuse; choose another fresh namespace for retry.
Do not confuse deleting only a helper pod with deleting the claims it mounted.

## Reproduce qualification

After the Kubernetes smoke, run with its local CA:

```sh
NODE_EXTRA_CA_CERTS="$PWD/.fogd/m9demo/certificate/ca.pem" \
  node scripts/kubernetes-recovery.mjs .fogd/m9demo
NODE_EXTRA_CA_CERTS="$PWD/.fogd/m9demo/certificate/ca.pem" \
  node scripts/kubernetes-recovery-negatives.mjs .fogd/m9demo
```

The first drill verifies fresh-volume D1/R2/DO state, native account/session recovery,
private revisions, scoped credentials, approval history, a pending approval, and new
writes. The negative drill checks corruption, foreign writable consumers, interrupted
shutdown, and source/restored namespace isolation. The node interruption takes at
least the three-minute termination deadline and temporarily affects both namespaces.
These scripts own only the named disposable local kind fixture and retain its PVCs.
