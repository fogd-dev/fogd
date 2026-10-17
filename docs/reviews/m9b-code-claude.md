The drill finished: PASS, snapshot ~100 s, restore ~91 s. Review follows.

**Verdict: no correctness blocker in the happy path, but M9b acceptance cannot be claimed yet.** Three defenses are missing in code, and five acceptance items are untested by the drill script.

## Blockers

1. **Fresh-claim assumption is never verified.** `packages/cli/src/kubernetes/recovery/pods.mjs:57` extracts into `/data` and then uses `tar --compare`, which only checks archive members. Extra pre-existing files on the volume pass silently. A leftover Released PV, or a PVC spec from the bundle that names `volumeName`, `selector` or `dataSource`, would restore onto a non-fresh disk and still write a receipt. Fix: before extraction, require `/data` empty (`find /data -mindepth 1 -print -quit` must be empty), and in `verifyKubeBundle` restrict each `manifest.pvc[].spec` to exactly `accessModes`, `storageClassName`, `resources`.

2. **images.tar is loaded without content verification.** `images.mjs:56` runs `docker image load` whenever any tag is missing locally. Docker load retags any RepoTags inside the archive, so a tampered or stale archive can clobber unrelated host tags before the post-load check at line 58 runs. Also backup saves images at `backup.mjs:29` minutes after the pre-stop identity check, so a retag during the archive window produces a "complete" snapshot whose images.tar disagrees with `manifest.images`. Fix: read the tar's own `manifest.json` (`tar -xOf images.tar manifest.json`) and require every RepoTag to be in `manifest.images` with `Config` equal to `<id>.json`; do this in backup before writing the completion manifest and in restore before load.

3. **Stop evidence does not distinguish graceful exit from SIGKILL.** `pods.mjs:9-21` only waits for pod absence. `backup.mjs:32` records pre-stop `lastState` and `restartCount`, which say nothing about the stop itself. With `terminationGracePeriodSeconds: 60`, a MinIO or celld process that ignores SIGTERM gets killed and the snapshot is an abrupt stop, yet the manifest cannot say so. The loss-boundary statement depends on this. Fix: poll each terminating pod's `containerStatuses[].state.terminated` (exitCode, reason) before it disappears and store per-pod exit evidence in the manifest. Refuse, or at minimum flag, any `exitCode != 0` or `reason != Completed`.

## Missing acceptance in `scripts/kubernetes-recovery.mjs`

- **Source restart isolation** is an explicit acceptance item and is never exercised. Scale the source namespace back up after the restored writes, then assert the restored notebook rows and sessions are unchanged and the source lacks the post-restore entry.
- **Corruption or missing archive must fail before namespace creation.** Not tested. Copy the bundle, flip a byte in one claim tar, run restore into a new namespace, assert rejection and that the namespace does not exist.
- **Foreign writer refusal.** Not tested. Create a bare pod in the source namespace, run backup to a new directory, assert rejection and no `manifest.json`.
- **Refusal must not mutate the target.** Line 64 only asserts rejection. Capture target resourceVersions or pod list before and compare after.
- **Midway failure leaves explicit incomplete output.** Not tested, and the "explicit" marker does not exist. Suggest writing a `started.json` with phase and `stoppedAt` before archiving so an incomplete directory carries evidence rather than only lacking the completion file.

## Secondary findings

- **Backup cannot resume after a failed snapshot.** `inventory.mjs:32` requires live replicas equal to desired, so retry forces the operator to restart writers, which conflicts with "retain stopped". Decide whether an already-stopped source is a supported backup input; if so, skip `verifyRunningImages` and record that it was captured stopped.
- **Shape validation leaves gaps for malformed bundles.** `shape.mjs` ignores `initContainers` (they could mount `data` writable), `hostNetwork`/`hostPID`, `securityContext.privileged`, and validates nothing about Services. An `ExternalName` Service named `minio` redirects the bucket outside the namespace while the `S3_ENDPOINT` check passes. Bundles are operator-private, so this is defense in depth, but restore applies these objects verbatim.
- **`tar --compare` at `pods.mjs:60` lacks `--numeric-owner`**, unlike create and extract. Owner comparison may go through the helper's passwd rather than UIDs.
- **Helper lifetime ceiling.** `activeDeadlineSeconds: 900` plus `sleep 900` means an 8 Gi MinIO claim read twice over kubectl exec can exceed the window and fail late. Safe failure, but document or scale with claim size.
- **Pre-stop diff conflates drift and error.** `kubectl diff` exits 1 on differences and higher on failure; `execute` reports both as the same generic error. Acceptable, but an operator cannot tell which.
- **`connection.mjs:9` hardcodes `kind-fogd-m9*` contexts.** Fine for the fixture, but it means the adapter is unusable for any other local kind installation without a code change.

Verified sound: pre-stop inventory and single-writer checks, owner-UID pod verification, Terminating pod rejection, read-only helper mounts with capability drop, node-affinity placement verification via PV, fleet ordinal anti-colocation, stream checksum against a second in-pod read, fsync ordering with manifest last, namespace refusal before any cluster mutation, StatefulSets applied with replicas zero, no force or delete paths, and namespace-relative addressing (anti-affinity selectors default to the pod's own namespace, so a restarted source will not interfere).