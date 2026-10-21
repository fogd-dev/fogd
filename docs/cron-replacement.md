# Qualify scheduled release replacement

The historical [replacement profile](evidence/m11c-cron-replacement.json) measures compatible
migration overlap, lost completion around publication, and native retries for
ordinary Void jobs. Cron admission remains closed. Stopped recovery, retirement
and release-bound runtime qualification remain separate [M11c gates](m11c.md).

## Replacement contract

A confirmed dispatch pause prevents new callbacks; running work is not drained.
Old code can still write while compatible migrations run. The profile applies a
real additive migration, observes its ledger entry, then lets an already-started
old callback commit against the changed schema before publication continues.

Publication and replica adoption can leave old work without a recorded completion.
The profile holds advisory before its business commit and inventory after its
commit in the same occurrence. Both keep recording heartbeats after confirmed
pause and migration. Their last durable heartbeats occur near the owning node's
generation swap; the old generation is then freed. The attempt rows remain unchanged
beyond the operation deadline. Inventory's result survives; advisory has no saved
result and appears in the app's unfinished-work view. Later native occurrences use
new code. This observes database progress, not termination of arbitrary external
effects or `waitUntil` work. It is not a drain or a version fence.

No replay of the interrupted occurrence is observed during this bounded profile.
Applications must not rely on automatic replay after an update. An external effect
may have happened before a missing local commit. Reconcile retained application
input and saved results according to the application's own rules. This refresh
example gets current data on future ticks and retains unfinished historical rows;
it does not provide a general replay or acknowledgment action.

A separate final-release occurrence simulates a lost reply by throwing after its
acknowledged D1 batch commit. The driver observes the persisted native retry wake
before its deadline. Both jobs' second attempts follow that deadline and their
first completion, under the same owner, with the original cron and scheduled time.
The successful sibling runs again. Duplicate counters demonstrate the retry; the
business key keeps one result per job. Another healthy native tick is required.

Operator dispatch status and deployment inspection include an interruption notice.
The approval card displays it beside the deployment being reviewed. Runtime
observations remain separate from application outcomes.

## Historical reproduction

This receipt's complete source map matches commit
`d9b28e957de8e3b6babbb79cfdffb6946ab06a9e`. Use that revision and its recorded
runtime for historical reproduction. Current `scripts/cron-replacement.mjs`
refuses execution and points to the [sealed replacement profile](cron-sealed-replacement.md).
The historical receipt does not qualify the signed release binary or native
default timing. The commands below apply only to that pinned revision.

### Run at the pinned revision

Prepare a [disposable installation](queue-qualification.md#prepare-a-disposable-installation)
with current controller sources and the qualified [cron control candidate](patches/celld-cron-controls.md)
on every replica. Workerd must resolve routes through the private controller's
internal listener on port 8084. Both selected replicas require
`CELLD_HANDLER_BUDGET_S=30` and `CELLD_OPERATION_DEADLINE_MS=60000`. Select a
never-deployed two-node fleet and a new output directory under `.fogd`:

```sh
FOGD_ENV_FILE="$PWD/.fogd/cron-replacement-fixture/probe.env" \
  node scripts/cron-replacement.mjs slot-2 .fogd/cron-replacement-evidence
```

The driver creates three private copies of the refresh app with literal release
labels, additive diagnostic SQL and ordinary `defineScheduled` entry points. A
resumable private controller checkpoint observes old work after migration and
before publication. It does not change production approval behavior. HTTP changes
source policy and reads outcomes; it never invokes a scheduled job. All ordering
uses one Docker VM's kernel clock. Host time only bounds polling.

Both ordinary Void and fogd builds pass with networking disabled for all three
copies; normal staging still rejects their cron declarations. The evidence records
source snapshots, runtime fingerprints and the framework/runtime patch prerequisites.
Entry logging cannot observe invocations that fail before their first durable
INSERT. The unfinished view shows up to twenty matching historical rows and a
count of additional rows; an already-failed occurrence keeps its failed status.

Require terminal exit zero, no failure or cleanup-failure file, matching sources,
private-value omission and selected-service logs without runtime fences, panics or
storage exhaustion. A printed pass precedes cleanup. Stop the full disposable
installation afterward, retaining private output and volumes. Do not infer stopped
snapshot recovery, retirement, topology expansion or external effects exactly once
from this profile.

Correlate the owning node's exact generation with its swap and free log records.
Check that the swap follows the recorded publish request and precedes confirmed
activation, and retain the signed heartbeat offset. Publication and replica
adoption are separate steps; a deploy command reply is not an atomic version fence.
