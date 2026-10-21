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

## Clock and log scope

The operator and controller-interruption profiles compare native occurrence times,
controller observations and fault boundaries using the Docker VM clock. Host
wall time only bounds observer waits. Their accepted log scans begin at a stable
fixture service startup timestamp from Docker inspection, in the same clock
domain. These replays supersede the earlier unmeasured host/VM alignment assumption.

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
volumes and private logs if cleanup fails. The [retry candidate](patches/celld-cron-retry.md) preserves identity in a built
two-node owner-loss test. The separate [native hold candidate](patches/celld-cron-controls.md)
has bounded qualification; platform activation and full recovery remain open.

## Handler-budget termination

The [timeout probe](../scripts/cron-timeout.mjs) isolates unresolved-promise
termination from the shorter native operation deadline. Before starting its
never-deployed disposable fleet, configure both selected replicas with
`CELLD_HANDLER_BUDGET_S=20` and `CELLD_OPERATION_DEADLINE_MS=60000` in the rendered
Compose service environment. The probe rejects a deadline at or below the handler
budget. Run on the retry-only candidate image; a runtime with native dispatch
controls starts held and requires its own explicit resume protocol.

```sh
FOGD_ENV_FILE="$PWD/.fogd/cron-fixture/probe.env" \
  node scripts/cron-timeout.mjs slot-1 .fogd/cron-timeout
```

The scheduled handler writes an R2 event and awaits an unresolved promise. The
probe sorts events, captures the actual future minute-aligned wake, observes a
callback at that wake and only then counts callbacks for the original occurrence.
It rejects runtime lease fences and panics. The finalizer attempts a no-cron
publication even when diagnostic capture fails. Stop the disposable installation
and retain its volumes if cleanup fails.

The [shorter-deadline observation](evidence/m11c-cron-operation-deadline.json)
rejects the earlier six-callback claim: the default 15-second operation deadline
with a 20-second handler budget produced seven callbacks before advancement.
Native `retryCount` is not a direct callback counter when the operation expires
before host termination settles. Neither configuration proves CPU exhaustion,
an arbitrary application retry ceiling or retention of every missed tick.


The [isolated watchdog evidence](evidence/m11c-cron-timeout.json) records six final
callbacks at the original scheduled time, the future wake and its actual callback.
Two intermediate minute occurrences were skipped. The immediate no-cron cleanup
read still had an older callback retiring; both replicas had adopted a later
generation, and the runner stopped the whole disposable stack. That read is not a
drain receipt. The result qualifies only this recorded termination profile.

## Native Void refresh jobs

The [refresh example](../examples/refresh/README.md) uses ordinary Void cron
discovery for two jobs sharing one expression. Its
[bounded native evidence](evidence/m11c-void-refresh.json) records real minute
callbacks, successful-sibling retries, a visible source failure with retained
success, and a simulated lost reply after a committed D1 result. Ledger attempts
and duplicate counters establish that handlers ran again; the result table's
unique occurrence key constrains business rows. The browser and API use workerd
with normal authenticated controller route lookups.

The same source builds through ordinary Void and fogd in a container with
networking disabled. A generated declaration check confirms one expression and a
required private value, while normal artifact staging still rejects cron.
The runtime drill privately stages the declaration through the experimental
coordinator; it does not open admission or complete the M11c lifecycle gates.
The [ordinary Void failure profile](cron-failures.md) separately qualifies owner
loss, `noRetry`, counted terminal retries and downtime. Selected native controller
interruptions have [separate evidence](evidence/m11c-cron-interruptions.json).
[Compatible replacement](cron-replacement.md) has a separate migration and
publication profile. [Stopped recovery](cron-recovery.md) has a full bounded rerun
with due timers, pending retries, queued input and an older snapshot.
[Retirement](retirement.md#experimental-scheduled-app-retirement) has separate
bounded cron/queue and two-cron profiles. Ordinary cron admission remains closed. Inspect
runner exit, cleanup and selected service logs before accepting a result; the evidence
rejects the earlier gateway
harness and storage-exhaustion trials.
