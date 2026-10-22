# Selected runtime scheduled failures

The [selected failure receipt](evidence/m11c-selected-runtime-failures.json)
qualifies native failure and downtime behavior on the frozen local Linux arm64
Docker candidate, using ordinary offline-built Void artifacts and scoped HTTPS
approval. It covers M11c's native failure gate and the example's failed-work
browser state. Replacement, active-survivor retirement and the complete acceptance
audit remain open. Public candidate enrollment and ordinary cron admission stay
closed.

## Reproduce the profile

Use the commit that introduces this receipt. Its source inventory identifies the
executed qualifier files; its recorded base commit alone omits the uncommitted
implementation. The cached runtime, storage and SDK images must match the receipt.
The checkout needs its cached dependencies and Playwright browser. From its root,
run the [driver](../scripts/cron-probe/selected/failure-profile.mjs):

```sh
node scripts/cron-probe/selected/failure-profile.mjs .fogd/selected-failures-UNIQUE
```

The directory must be new. The fixture creates a private two-fleet installation,
reserves loopback ports and uses internal candidate enrollment. It never builds
images, compiles native code, installs dependencies or calls hosted services.
The recorded run takes 1,358.2 seconds. Inputs, credentials, artifacts, screenshots,
logs and observations remain private in ignored storage. Cleanup removes only the
fixture's containers and networks, retaining all eight named volumes.

## Artifacts and native outcomes

Both minute and sparse artifacts build through ordinary Void and the normal fogd
build API with networking disabled. Generated declarations, raw configs, dependency
and patch fingerprints, immutable manifests and canonical artifacts are retained.
The exact offline files pass scoped upload, download comparison and approval.
Three distinct approvals use minute, sparse and the original minute artifact;
the final digest equals the first while the deployment identity differs. The
retained controller confirms the old approvals are superseded and the final one
is active with dispatch paused.

The minute fixture first completes a native healthy occurrence. Advisory then
calls native `noRetry()` and throws while inventory succeeds. Dispatch remains
running through the next natural minute. The original occurrence has no retry,
and a later healthy occurrence completes. The owner-loss case supplies the
positive retry control: two advisory failures precede an owner SIGKILL, followed
by success on the survivor for the original scheduled time. Successful inventory
work repeats without duplicating its business result.

The owner already holds the advisory waker role in this run. Paused preparation
records resident cron state and quiescent counters on both replicas; these are
observations, not an atomic rebalance fence. The cut is confirmed 7,458 ms before
the persisted retry deadline. Recovery follows native lease expiry and election;
the successful retry enters 150,858 ms after its original deadline. The owner
restarts in the same container with a new signing key. Untouched processes, keys
and the import application's saved rows remain unchanged.

On the three-minute schedule, advisory reaches six thrown attempts while inventory
succeeds six times with one business result. Native minimum retry intervals follow
the measured backoffs. A future sparse occurrence succeeds, and all prior rows
survive the return to the minute artifact. Six attempts describe this sparse
profile; they are not a universal watchdog count. The profile does not qualify per-worker CPU quotas or CPU exhaustion.

## Downtime and the quiet interval

Both exact app-slot containers receive SIGKILL before an armed minute deadline.
They remain stopped across three due boundaries. The same containers restart;
only their processes and signing keys change. During restart and the following
45.436 seconds, the qualifier makes no native, admin or application request into
the affected fleet. It permits Docker start/inspection, storage-only observations
and a clock on the untouched fleet. Replica healthchecks are absent. The request
journal describes the runner's explicit calls; it is not a packet trace.

Before the first ledger request, storage already contains a newly persisted wake
for the next natural minute. Its listed S3 key and modification time override any
same-named JSON-body fields. Membership authority is deferred until fresh signed
proofs after the first read bind the captured lease keys. Both overdue jobs finish
before the first request; the last completion precedes it by 29.873 seconds, and
the future wake precedes it by 29.738 seconds. Two intervening due minutes are absent from both the first and
final ledgers. The captured next-minute occurrence later completes successfully.

Wake objects are advisory hints, not the authoritative current alarm. The native
retirement frontier permits obsolete hints to remain until collection; the
qualifier records other hints without claiming prefix cleanup. This run has none.
It makes no full-slot ownership-epoch or waker-election guarantee. Those records
remain observations; the separate owner-loss case measures its required role
transition.

## Browser, pause and independent acceptance

The browser checks the ordinary app's local unavailable-source mode. Inventory
shows a saved result while advisory shows a useful failure and its previous
successful value and timestamp. A later healthy native occurrence restores the
saved state. Baseline, failure and recovery screenshots have no page errors and
pass visual inspection. Source-mode changes do not manually trigger jobs.

The final confirmed pause crosses another minute plus the native operation
deadline and an observation margin. A second read must preserve every row in the
attempt, occurrence and business-result ledgers, with native pause still confirmed
and no next alarm. Final checks also cover earlier pause/preparation intervals,
late writes, original retry identity, unique results and both update histories.

Independent acceptance verifies all 452 executed source files, 210 signatures and
210 altered-signature refusals, both offline artifact file sets, all three retained
controller approvals, native replica versions, image contents and cleanup. All
seven non-gateway services exit zero; workerd exits one, which the recorded stop
profile permits. No service reports an out-of-memory kill or automatic restart.
Privacy checks include decoded uploads, scoped status, offline outputs, browser
text, ordinary errors, runtime logs and final receipt bytes. The standard command
passes all 860 tests, and syntax, whitespace and quality gates pass.

The application ledger excludes invocations that fail before their first durable
write, including process loss and unavailable storage. This profile does not prove
general drain, exactly once external effects, storage cleanup, remote operation,
Workflows or arbitrary Durable Object alarms.
