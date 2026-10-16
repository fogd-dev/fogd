Review of `docs/m9b.md` against the current source. Verdict: the design is sound in intent, but three details will produce a wrong restore on kind unless they are explicit in the adapter. The rest of the plan reduces to a thin Kubernetes sibling of `backup.mjs`/`restore.mjs`.

## Safety blockers

1. **Restore helper placement collides with fleet anti-affinity.** kind's local-path provisioner uses WaitForFirstConsumer and pins each PV to the node where the first consumer ran. Each fleet StatefulSet requires its two ordinals on different hostnames (`workloads.mjs:18`). If the restore helpers for `data-slot-1-0` and `data-slot-1-1` both schedule on the same worker, the restored PVs are both pinned there and the fleet pods can never schedule. The adapter must give the helper pods the same required anti-affinity, labelled as the fleet they restore, or set `nodeName` explicitly and record it. The design's last paragraph names the risk but does not say how placement is chosen. Make it the rule, and have the acceptance test assert each fleet's two PVs have different node affinities after restore.

2. **Applying rendered StatefulSets starts writers before data lands.** `manifests.json` carries `replicas: 1` and `2`. If restore applies it as-is and then scales to zero, pods start, init-bucket runs, celld and the controller write to empty PVCs during the race. Restore must create namespace, Secrets, Services, and PVCs first, run helpers, and only then apply StatefulSets patched to `replicas: 0`. Scaling to zero also does not create claims, so the PVCs must be created explicitly with the template names (`data-<set>-<ordinal>`) and identical storageClass/size/accessModes so the set adopts them. Note PVC creation itself does not bind on kind until a consumer exists, so the helper is the required first consumer, which ties back to blocker 1.

3. **Local image tags are mutable, and restore has no identity gate.** Pull policy Never with `fogd-runtime:<cluster>` tags means a rebuild between snapshot and restore silently changes what the restored pods run. The smoke already compares `crictl inspecti` against `docker image inspect` (`kubernetes-smoke.mjs:68`). Restore needs that same check against the recorded image IDs on every node before applying workloads, and must fail rather than load if they differ. The design records identities but never says restore verifies them pre-mutation.

Lesser items worth a line each in the implementation:

- **Exec-stream truncation.** `kubectl exec ... tar -cpf -` can end with a nonzero status on disconnect, but a clean-looking short stream is still possible with websocket proxies. Have the helper compute sha256 in-pod and emit it on stderr or a second exec, and compare with the local fingerprint before recording. That one comparison is the evidence that the archive is the disk.
- **Pre-stop verification is one command.** `kubectl diff -f manifests.json` exits 1 on drift and 0 on a match. Run it before scaling down. It covers "verify current workload definitions" without reimplementing a comparer against server-defaulted objects.
- **Foreign writer check scope.** PVCs are namespaced, so listing pods in the namespace whose `volumes[].persistentVolumeClaim` names a snapshot claim is complete. Terminating pods on an unreachable node still appear in that list, which is exactly what makes the "unresponsive node fails the snapshot" rule hold. Do not special-case Terminating.
- **Helper lifetime.** Give helpers `restartPolicy: Never` and `activeDeadlineSeconds`. A stale helper from a failed run otherwise trips the "unrelated pods" rejection on the next attempt with no hint why.
- **Incomplete marker.** `writeJson` uses `wx` and writes `manifest.json` last. A directory without it is the incomplete output. Document that instead of inventing a second marker file.
- **Namespace isolation claim is already true.** Controller state persists only slot ids (`controller.mjs:55`), celld advertises `$(CELLD_NODE).slot-N` and the bucket endpoint is `minio:9000`, all namespace-relative. Isolation needs a test, not a design change.

## Simplest implementation

One file, `packages/cli/src/recovery/kubernetes.mjs`, exporting `kubeBackup(dir)` and `kubeRestore(dir, namespace, output)`. Reuse `fingerprint`, `writeJson`, `readJson` from `bundle.mjs`. Do not import `validateTopology`, `verifyBundle`, or anything from `docker.mjs` except by generalising its spawn helper. That helper is already the right shape (file descriptor stdin/stdout, 0600 output, credentials kept out of errors). Rename it to `exec(command, args, opts)` and keep `docker` as a one-line alias, then call `exec('kubectl', ...)` for the streams.

Snapshot format `fogd-kube-stopped-v1` with: `manifests.json` and `secrets.json` captured live, `topology.json`, `images.tar`, one `<claim>.tar` per PVC, `manifest.json` with stop timestamps, pod terminal states, image IDs per node, PVC name/uid/volume/storageClass/size, helper node placement, and fingerprints. Require explicit `--kubeconfig` and `--context` from the installation directory, as `kubernetes-client.mjs` already does. Refuse the implicit current context.

Order on backup: load topology, `kubectl diff`, list pods and reject anything outside the five StatefulSets, capture live objects, scale workerd and controller to 0 and `wait --for=delete`, then slot-1 and slot-2, then minio, re-list pods and require none, run read-only helper per PVC streaming tar to file, fingerprint, `docker image save`, write manifest last.

Order on restore: verify every fingerprint, refuse if namespace exists, refuse if target equals source, verify node image IDs, create namespace, Secrets, Services, PVCs, run helpers with anti-affinity to extract with `--numeric-owner` and `sync -f`, run compare helpers with `tar --compare`, apply StatefulSets with `replicas: 0`, write receipt that prints the scale-up order. Leave starting to the operator, as the design says.

Skip for now: a separate `kube verify` command, any abstraction shared between Docker and Kubernetes bundle validation, and remote registry handling. Add when a second cluster type exists.

## Evidence required

- Two-app fixture snapshot and restore into a new namespace on the same kind cluster, with the smoke's existing checks (notebook entries, session, PVC identity table, image identity table) rerun post-restore, plus one new write, one new pending approval, and a scoped token reuse.
- Per-fleet PV node affinity differs across ordinals after restore.
- In-pod sha256 equals local fingerprint for every archive.
- `kubectl diff` exit 0 before stop, and the recorded pod list empty before the first helper mounts.
- Negative tests: corrupted archive fails before namespace creation, existing namespace refused with no objects created, a stray pod in the source namespace blocks the snapshot, and a stopped worker leaves a Terminating pod and the snapshot fails with no `manifest.json`.
- Start the retained source namespace after restore and show both installations serve their own data with no cross-traffic.
- Record durations and state the loss boundary as "everything written after the last pod deletion in the stop sequence".