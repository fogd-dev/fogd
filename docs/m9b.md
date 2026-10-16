# M9b: stopped Kubernetes recovery

## Scope

Qualify complete stopped recovery of the experimental local kind installation into
a fresh namespace with fresh PVCs. Preserve the same pod ordinals, Service names,
controller metadata, private revisions, bucket, every replica disk, and TLS keypair.
The namespace may change because fleet addresses use namespace-relative Service DNS.
Do not call this remote-cluster, live backup, or storage-provider qualification.

## Proposed adapter

Add a separate Kubernetes snapshot format and explicit commands. Do not reinterpret
Docker tar bundles as Kubernetes storage. Reuse streaming archive/checksum helpers
where their contract fits, without forcing Docker topology validation onto Kubernetes.

Before stopping anything, require the generated experimental topology, verify current
workload definitions and exact single-writer layout, and reject unrelated pods,
Jobs/CronJobs, writable claims, external bucket endpoints, or unknown controllers in
the namespace. Capture live manifests, Secrets, PVC size/storage-class requirements,
image identities, and observed pod/claim identities into private output. For local
kind, save the exact images from Docker and verify their identities against those
running on nodes. Remote registry-backed recovery remains a separate qualification.

Stop gateway/controller first and wait for deletion; then stop both fleets and wait;
then stop MinIO. A node that cannot acknowledge termination blocks the snapshot.
Never force-delete an unreachable process to manufacture quiescence. Confirm all
source workload pods are absent before mounting storage in helper pods. Retain the
source installation stopped after completion or failure.

Mount each claim read-only in a short-lived helper pod, stream a tar archive to a
private local file, checksum it, and record actual image/configuration identities.
A completion manifest is written last, after file fsync. Include TLS/credential
Secrets in the private manifest archive. Record stop/crash evidence and duration.
No automatic data-loss or live-replication claim follows from a successful tar.

Restore verifies every file before cluster mutation, refuses an existing target
namespace, and creates new claims and stopped workloads with the original identities.
Use helper pods to restore numeric ownership, sync, and compare archives before
writing a receipt. Do not start application writers automatically. The operator
starts MinIO and verifies it, then fleets/controller, then gateway. Record that
startup order and test it, including retained scoped tokens and sessions.

## Acceptance

A two-app fixture contains D1/R2/DO records, an account/session, secret revisions,
scoped deploy credentials, and approval history. Stop and snapshot it; restore to
fresh claims under a new namespace; verify all of those plus subsequent writes and
a pending approval. Verify that old and new namespace-relative replica addresses
stay isolated even if the stopped source is later started separately.

Corruption or missing archives must fail before creating a namespace. Existing
namespace/claim refusal must not mutate the target. A foreign writer or unresponsive
source node must fail without claiming a complete snapshot. Failure midway leaves
an explicit incomplete output and no automatic startup. Measure duration and state
the loss boundary. Keep namespace/PVC deletion out of normal recovery commands.

Review the adapter before implementation. If kind local-path placement requires a
consumer before claim binding, helpers provide that consumer; they must not change
replica identity or permit an old source process to share the restored disks.
