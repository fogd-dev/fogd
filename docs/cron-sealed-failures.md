# Experimental scheduled failures on the guarded release runtime

The [sealed failure receipt](evidence/m11c-sealed-failures.json) records ordinary
Void jobs under native failure, owner loss and downtime of both app-slot replicas on local Linux
arm64 Docker. It uses the signed release executable, immutable qualification
programs and approved artifacts built offline. Ordinary scoped cron admission,
scheduled CLI restore and scheduled retirement remain closed. The other slot's two replicas remain running. The receipt's source fingerprints identify the
executed qualification revision; reproduction requires matching those files.

Reproduction of this receipt requires a separate checkout of
[77cd27c](https://github.com/fogd-dev/fogd/tree/77cd27cf6d4837e6b37aa642aaa3ded68022f46f).
Current shared qualification helpers have changes outside this historical receipt.

## Reproduce the profile

With the local images identified in the receipt available, run the
[driver](../scripts/cron-sealed-failures.mjs) in a new private directory:

```sh
node scripts/cron-sealed-failures.mjs .fogd/NEW_SEALED_FAILURES
```

The fixture reserves loopback ports 8956 and 8957 and private networks
`10.252.244.0/24` through `10.252.246.0/24`. Run one instance at a time with those
resources available. Allow the full native schedule and its retries to run;
the controller session permits 35 minutes. The gateway serves the refresh app
through workerd. The controller uses private commands and an internal gateway
lookup listener. External admin and TLS operation have separate acceptance gates.

Only the fixture's fresh project is started and stopped. Cleanup removes its
containers and networks while retaining seven volumes. Inputs, commands, logs,
controller state and audit archives contain private values; keep them in ignored
storage. The image reuses checked native and dependency bases. Builds use no
network access, dependency installation or Rust compilation.

## Authority and evidence

The shared [release broker](../scripts/cron-probe/release/controller.mjs) accepts
only the named sequence in its immutable contract. The first and final approvals
use the same minute-schedule artifact, separated by a three-minute schedule.
Durable completed approval order distinguishes the final approval from the first;
a digest alone cannot identify that phase. Command data cannot choose a source
path, executable, schedule or publication gate.

Both artifact variants build through ordinary Void and fogd with networking
disabled. Their generated declarations, required secret and D1 resources must
agree. The exact offline outputs are copied into the approved inputs and hashed
again after staging. Normal artifact staging continues to reject cron.

The profile preserves the [historical failure oracles](cron-failures.md):

- A native successful occurrence produces browser-visible saved results.
- Advisory calls native `noRetry()`, inventory succeeds, that occurrence has no
  second recorded attempt, and a later healthy occurrence succeeds.
- The owner is killed after two advisory failures and before the persisted retry
  deadline. The survivor retains cron and original scheduled time, advances
  ownership, and preserves unique business results when the sibling runs again.
- Counted advisory failures reach six recorded attempts per job on a three-minute
  schedule. Inventory succeeds on each attempt; a later healthy occurrence succeeds.
- Both replicas are killed across three due minute boundaries. After restart,
  neither receives a probe request for at least 45 seconds. The overdue work must
  enter and finish before the first ledger request. A different future wake must
  already exist in storage before that request. Intermediate due minutes are
  absent from the ledger, and a later healthy native occurrence succeeds.

The narrow pre-kill observation combines read-only ledger, wake, native status and
owner-generation reads. It records sub-operation latencies. Actual SIGKILL exit
codes and VM timestamps must establish a cut before the retry deadline. After the
cut, read-only observations retain the retry entry, waker-role lease and killed
node's lease. The full profile requires the killed owner to hold the advisory
waker role, then measures the survivor's claim after its expiry. Its observation
window combines those leases, the retry deadline and the native scan interval,
with an explicit empirical allowance and a fixed ceiling. That allowance is not
a native operation deadline or a general recovery-latency guarantee. Every failed
poll remains in the private evidence. Restart
checks require the same containers and images, fresh running processes and current
membership. Signed identity proofs cover all four replicas before activation,
after owner rejoin and after full-fleet restart. Restarted process keys must change;
untouched replica keys must remain stable.

Native handler, operation and generation-maintenance defaults remain in force.
The receipt records their source hashes and checks the actual replica environment
for overrides. Six counted attempts in this profile do not establish a universal
watchdog callback count. There is no per-worker CPU quota or CPU-exhaustion
qualification.

## Accepting a run

Require terminal driver exit zero, final paused journal, full cleanup, matching
source fingerprints, immutable image programs and independently verified signed
proofs. Check retained artifact bytes and controller state, all service exits,
and runtime logs for fences, panics, out-of-memory and storage exhaustion.
The accepted stop profile permits workerd exit 0 or 1; every other service must
exit 0, with no OOM or runtime-fence findings. `shutdown.earliest` is the run-start
lower bound for log collection. `quietUntil` records the end of the minimum
no-request wait; the actual quiet interval ends at `firstReadAt`.
A printed pass alone is insufficient. Preserve failed runs and retained volumes.

Each attempt records entry before its first asynchronous yield and stores an
append-only outcome separately from the idempotent business result. Final checks
include late writes and entries during confirmed pause. The ledger excludes a
callback that fails before its first durable write, including process loss or
unavailable storage. This profile does not qualify general callback drain,
external effects exactly once, remote operation, hosted Cloudflare execution,
recovery or retirement. Those paths retain their separate evidence scopes.
