Review of M10c, grounded in the code. Short answer first, then findings.

**Measure first, then qualify a selectable two-or-three fleet topology is sensible.** The measurement is cheap and the expansion is not. The costly part of M10c is not the third fleet but removing the fixed two-fleet lists baked into the recovery code. Treat that generalization as the real deliverable, with fleet count as one validated parameter.

## Blockers

- **Fixed inventories live in at least six places, and the spec should name them.** The service and volume lists in `packages/cli/src/recovery/docker.mjs:10-11`, the topology check in `packages/cli/src/recovery/bundle.mjs:28`, the file set in `verifyBundle` at line 51, the per-service loop in `packages/cli/src/recovery/inventory.mjs:16`, the stop ordering in `packages/cli/src/recovery/backup.mjs:20-22`, and the slot regex in `packages/cli/src/recovery/retirement-plan.mjs:12`. Kubernetes has its own in `packages/cli/src/kubernetes/recovery/contract.mjs` and the regex at `shape.mjs:43`. Derivation must replace all of them in one change, or a three-fleet bundle will pass backup and fail restore.
- **The bundle file set must be derived after the compose.json checksum is verified, not before.** Today `verifyBundle` builds the expected file list from a constant, then checks checksums. With derivation, read the manifest, verify compose.json, derive volumes from it, then compare against the manifest's file keys. Keep the format name unchanged. A two-fleet bundle derives to the same list, which satisfies the compatibility requirement for free.
- **"Generate a complete Compose installation" has no counterpart in the code.** The installation is a static compose.yaml with anchors, and `fogd up` just invokes it. A generator creates a second source of truth. The cheaper reversible path is to add slot-3 services, a fleet-3 network, and two volumes to compose.yaml under a Compose profile, and move the slots literal to an env variable the CLI writes. Backup must then pass the active profile through to `compose config`, otherwise the "unexpected services" check rejects a valid install.
- **The captured project always contains an exited container.** bucket-init runs once and exits. A capture that enumerates "running containers by label" will report it missing. Define required services as "present with expected state", not "running".
- **Wording conflict.** The spec calls the Kubernetes two-fleet topology "separately qualified". The roadmap and report call it experimental local evidence. Fix the spec.

## Measurement mistakes to avoid

- **Idle is ambiguous.** celld keeps up to 100 resident cells after traffic. Record cold idle after a fresh start and warm idle after the load window separately, or the per-fleet memory number drifts with history.
- **Docker Desktop numbers describe a VM.** Record from `docker info` the operating system string, NCPU, MemTotal, and cgroup version. Add swap totals read from a helper container, since the VM has swap by default and memory can "fit" while thrashing. Label every report as virtualized.
- **CPU percent semantics.** Docker's CPU percent treats one full core as 100, and a celld limited to one CPU can still report 100 on an eight-core VM. State NCPU next to the samples.
- **The comparison must hold per-app load constant.** Two fleets versus three at the same total request rate measures less load per app. Fix requests per second per app, so totals scale with fleet count.
- **Hit both tiers.** A read-only asset endpoint exercises workerd only. The workload must include a D1-backed route so celld is actually measured.
- **Certificate verification needs the installation CA.** Node fetch requires the CA at process start via the extra CA environment variable or an explicit agent. Name the mechanism, since this is where a load script quietly turns verification off.
- **Sleep detection.** Record monotonic time alongside wall-clock per sample and reject an interval whose wall-clock span exceeds roughly twice the expected duration.
- **Reuse the existing identity checks.** The first lines of `backup` already resolve config, validate topology, and run `inventory`, which returns image identities and verifies env and mounts without dumping inspect output. Capture should call that path, not reimplement it.

## Topology and recovery traps

- **Stop ordering must survive derivation.** Gateway, controller, every replica, then bucket. Encode it as a rule, not a list.
- **Retirement assumes replica names end in a and b.** With derived topology that assumption moves into the validator. The controller picks the first free slot for a replacement, so a retired slot-2 in a three-fleet install is reused by whatever deploys next. Fine, but the test should cover it.
- **Restore disk and time grow linearly.** Restore extracts and then runs a full tar compare on every volume, so three fleets means six replica archives verified. The spec's cost section covers downtime but should say disk doubles during retirement because source and target coexist.
- **Ceiling totals today.** Two fleets sum to 3584m of configured memory. Three fleets sum to 4608m, plus ten configured CPUs against a typical laptop VM. Show these and say they exceed the measured capacity on most laptops, which is exactly why ceilings are not reservations.

## Reversible scope reductions

1. Ship topology derivation with fleet count fixed at two first. The byte-identical resolved config against the current compose.yaml is a free regression test. Then enable three.
2. Use a Compose profile plus an env-provided slots literal instead of a generator. Deleting the profile reverts it.
3. Keep the Kubernetes side at "rejects anything but two" and touch only `kubeSettings`, where the count is hardcoded. Do not generalize its bundle format in this milestone.
4. One fixed workload for the load window. Skip percentile comparisons across fleet counts beyond "completed without errors" unless the idle delta already looks acceptable.