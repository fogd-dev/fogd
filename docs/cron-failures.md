# Qualify native Void scheduled failures

This disposable profile measures native failure and downtime behavior for ordinary
Void jobs. It privately stages a copy of the [refresh app](../examples/refresh/README.md)
through the experimental activation controller. Normal scoped cron admission stays
closed. The [M11c contract](m11c.md) also requires release overlap, stopped snapshot
recovery and retirement evidence before admission.

Use a fresh disposable installation from the [setup guide](queue-qualification.md#prepare-a-disposable-installation).
The controller must contain this checkout's platform sources; every replica must
use the same qualified [cron control candidate](patches/celld-cron-controls.md).
Keep the stock controller on its own state directory. Workerd must resolve routes
through the private controller's internal listener on port 8084. Select a
never-deployed two-node fleet and a new output directory inside this checkout's
ignored `.fogd` directory:

```sh
FOGD_ENV_FILE="$PWD/.fogd/cron-failure-fixture/probe.env" \
  node scripts/cron-failures.mjs slot-1 .fogd/cron-failure-evidence
```

The driver allows a 35-minute controller session, plus startup and cleanup. It appends a diagnostic migration and
replaces the two scheduled entry points in a private copy of the example. Both
still use ordinary `defineScheduled` discovery and delegate successful work to the
example's real refresh function. HTTP configures source data and reads results;
it never invokes a scheduled handler.

## Measured outcomes

The [accepted evidence](evidence/m11c-void-failures.json) records:

- A real successful native occurrence and browser-visible saved data.
- A failed advisory job calling the native `noRetry()` method, its successful
  sibling, no second recorded attempt for that occurrence, and a later successful
  native occurrence after changing the source policy.
- Owner SIGKILL after two failed advisory attempts and before a persisted retry
  deadline. New entries on the survivor retain the original cron and scheduled
  time. The successful sibling can run again; its business result remains unique.
  Recovery may cross a minute boundary. The evidence records crossed occurrences
  and the persisted wakes observed after recovery; it does not promise latency.
- A three-minute schedule with six recorded attempts per job for one occurrence:
  advisory throws each time, inventory succeeds each time. A later real occurrence
  succeeds after changing policy. This counted failure profile does not establish
  a universal callback count for watchdog or operation-deadline termination.
- Both replicas killed across three due minute boundaries. After restart, the probe sends no
  requests to either replica for 45 seconds. The overdue occurrence must have
  entered and finished before the first subsequent ledger request. Later native
  success is required, and intermediate due minutes are absent from the ledger.

Each job captures entry time before its first asynchronous yield. An append-only
attempt row records identity, policy, isolate instance and outcome separately from
the example's idempotent business result. Final checks include late ledger writes
and entry times during a confirmed pause after owner recovery. All ordering uses the Docker VM clock;
host time only bounds the observer's polling. The ledger cannot capture a callback
that fails before its first durable INSERT, including process loss or unavailable
storage. Absence from this ledger has that limit.

## Accepting a run

Require terminal exit zero, completed controller shutdown, no failure or cleanup
failure file, matching source snapshots and runtime fingerprints, and selected
service logs without lease fences, panics, out-of-memory or storage-exhaustion
errors. A printed pass precedes outer cleanup and is insufficient. Stop the whole
disposable installation after inspection, retaining private output and volumes.
If the run fails, preserve its evidence and inspect persisted state before deciding
whether the problem is the observer or the runtime.

Both schedule variants also build through ordinary Void and fogd with networking
disabled. The output retains native declarations and the required-secret declaration;
ordinary artifact staging still refuses cron. The fixture does not qualify
historical restore, release overlap, callback drain, external effects exactly once,
retirement, expansion, upstream Rust checks or CPU exhaustion.
