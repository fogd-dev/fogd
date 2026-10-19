# Probe native cron dispatch

The [native cron probe](../scripts/cron-native.mjs) exercises celld directly on a
never-deployed disposable fleet. It does not pass through fogd admission or prove
approval, migration ordering, timer pause, retries or recovery. Cron declarations
remain rejected by the ordinary fogd artifact translator.

Prepare a fresh two-fleet installation using the
[disposable setup guide](queue-qualification.md#prepare-a-disposable-installation),
with a new project beginning `fogd-m11c` and unused ports. That guide's queue opt-in
is irrelevant to this nonqueue probe. Then run from the repository root:

```sh
FOGD_ENV_FILE="$PWD/.fogd/cron-fixture/probe.env" \
  node scripts/cron-native.mjs slot-1 .fogd/cron-native
```

The probe publishes a plain Worker with a one-minute cron expression and an R2
binding, then waits for two native timer invocations. Every invocation writes a
separate record; the check detects duplicate occurrence times in this unfaulted
observation. The records preserve the native cron expression, scheduled time and
actual invocation time. HTTP only reads the observations; it never triggers work.

The finalizer publishes the same Worker without cron declarations and confirms
both replicas adopt it. This cleanup is not evidence of an independent pause or
of cancellation of in-flight callbacks. If cleanup fails, stop the disposable
fleet and retain its volumes and evidence. Do not use this probe on existing app
fleets. Its private output includes resolved runtime state; review it before
sharing. A completed probe is only the first transport check for the
[M11c lifecycle contract](m11c.md).

The [initial evidence](evidence/m11c-native-cron.json) records two occurrences and
the subsequent no-cron deployment on the pinned runtime. These are observations
of an unfaulted run. They do not establish scheduling latency or execution exactly once.

## Retry identity after owner loss

The [negative control](evidence/m11c-cron-retry-negative.json) confirms a defect in
the pinned runtime. A published retry deadline becomes the new scheduled time
on the surviving owner, and an already-successful expression runs again. The
[diagnostic review](reviews/m11c-retry-claude.md) explains the fault boundary.
On a separate never-deployed fleet using the unmodified runtime, run:

```sh
FOGD_ENV_FILE="$PWD/.fogd/cron-fixture/probe.env" \
  node scripts/cron-retry.mjs slot-1 .fogd/cron-retry
```

This is a negative control: success means it reproduced the defect. It observes
original callbacks, a retry wake publication, owner residency and the release hash
before killing the owner ahead of the deadline. It keeps that node down until the
survivor's outcome is recorded. A missed fault window fails the probe as inconclusive.
The finalizer restarts the node and publishes without cron declarations. Keep
volumes and private logs if cleanup fails. A targeted retry-identity patch is under review; timer controls and full lifecycle
qualification remain open.
