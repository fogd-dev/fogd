# M11c acceptance audit: bounded Docker scheduled work

M11c is qualified for trusted, reviewed Void applications on
`celld-cron-v2-linux-arm64`: local Linux arm64 Docker, two application fleets with
two native nodes each, MinIO, and workerd ingress. The public release check uses HTTPS. Default installations and
other runtime families do not gain scheduled admission.

An operator can approve unattended periodic work, inspect desired and observed
dispatch state, pause new callbacks, and recover held work before separately
resuming it. The [refresh application](../examples/refresh/README.md) saves results
and identifies failed or unfinished work. This implements one part of a cloud you
own and run; it does not qualify every Workers capability or deployment topology.

## Requirement audit

The numbered rows correspond to the [M11c contract](m11c.md#required-behavior-and-evidence).

| Gate | Evidence and accepted boundary |
| --- | --- |
| 1. Inert scoped upload; schema and secrets before execution | [Selected activation](cron-selected-activation.md) covers a real unpublished minute and a deliberately held migration minute. The [activation matrix](evidence/m11c-selected-runtime-activation-matrix.json) covers publication, native resume, and durable-release controller cuts. The [public-selector check](evidence/m11c-public-selection.json) repeats scoped HTTPS upload, unpublished boundary, exact secret revision, autonomous saved jobs, and ordinary CLI startup. |
| 2. Approval identity before effects; explicit uncertainty and retry | Activation pins digest and secret revision before ownership, migration, publication, or resume. Changed revisions and alternative held artifacts refuse; original retry remains explicit. `cron-activation.test.mjs` covers lost responses, ambiguous writes, durable reload, and SIGKILL boundaries. Corrected-artifact replacement of a held cron activation is explicitly unsupported and tested as a refusal. |
| 3. Dispatch authorization distinct from routing | [Unreachable-member pause](cron-selected-pause.md) stops a non-owner, non-waker member and records persisted unknown pause, continued future work through controller restart, unconfirmed rejoin, and explicit confirmed pause. Routing state is recorded; gateway HTTP during that outage is not measured. [Replacement](cron-selected-replacement.md) supplies the held-callback case on this binary: old work continues after dispatch hold and commits before publication. [Paused peer restart](cron-selected-failure-diagnostics.md) and [cold recovery](cron-selected-recovery.md) cover runtime restart. Confirmed pause blocks new dispatch; it does not drain existing callbacks or `waitUntil` work. |
| 4. Compatible replacement, overlap, and lost acknowledgment | Selected replacement records old work after compatible migration, new-release future work, an interrupted callback through generation release, and original-occurrence retries after a lost reply. Each job keeps one saved business row. The browser identifies unfinished work beside saved results. This is application idempotency, not exactly-once external effects. |
| 5. Native failure and timing behavior | [Selected failures](cron-selected-failures.md) covers success, thrown failure, `noRetry`, original-occurrence owner-loss retry, six counted sparse attempts, and full-slot downtime. It records scheduled versus attempt times, skipped minutes, future wakes, and first native backoffs of 4/8/16/32/64 seconds. A newer occurrence can supersede retry history; no universal callback ceiling or complete missed-tick backlog is promised. |
| 6. Operator state, application outcome, and privacy | Dispatch status separates desired/observed state and approval progress from application outcomes. Failure and replacement browser checks show saved success, failed/unfinished work, and recovery. Decoded submitted/downloaded artifacts, statuses, ordinary errors, logs, and published receipts are checked for private values. Runtime injection and recovery archives remain private operator data. |
| 7. Held stopped recovery, due/retry/older snapshots, explicit resume | The [selected recovery matrix](cron-selected-recovery.md) covers due timers, pending retries, an older snapshot, and queued survivor input. Native work stays held before controller startup and after reviewed acknowledgment. Separate resume produces future jobs without changing old rows. The public-selector check repeats ordinary restore with independent identity and fresh subnets, cold and acknowledged holds, explicit resume, and source preservation. This is same-version local two-fleet recovery; post-snapshot results can be lost and external effects can replay. |
| 8. Retirement, survivors, fresh authority, and topology refusal | [Sequential retirement](cron-selected-retirement.md) covers queued/cron survivors, a persisted retry, fresh queue/cron capacity, different declarations and configuration, old-authority refusal, and zero-live recovery. [Dual-cron retirement](cron-selected-retirement-dual.md) adds retirement beside another live cron and held restores of both sources. The public-selector check exercises ordinary scheduled retirement into empty fleets with retained original bytes. Three-fleet expansion and Kubernetes scheduled history remain refused. |
| 9. Ordinary offline builds, patches, native topology, and checked state | Selected failure and replacement artifacts were built through ordinary Void and fogd with networking disabled. The public-selector receipt records hashes and cron expressions for all ten managed/fogd generated declarations. The [binding receipt](evidence/m11c-runtime-binding.json) records the five native patches. The [failure receipt](evidence/m11c-selected-runtime-failures.json) and public-selector receipt also identify `patches/void@1.1.11.patch` by hash; [build configuration](build-output.md) identifies the build adapter. Native profiles use two nodes per fleet, workerd ingress, actual replica failure, signed identities, retained data, and independent image/file checks. No Cloudflare credentials, API calls, or hosted execution were used. |

The gate 2 regression names include “lost cron activation responses keep the
original approval and restart never resumes implicitly,” “approval pins artifact
and secrets before ownership effects and retries retain the selected revision,”
and “ambiguous metadata writes stop further cron effects and require disk reload
before explicit retry,” in
[cron-activation.test.mjs](../packages/platform/test/cron-activation.test.mjs).
Its admission-foundation case refuses corrected replacement of a held cron.
Gate 8 refusal checks live in
[cron-retirement.test.mjs](../packages/cli/test/cron-retirement.test.mjs),
[cron-preboot-restore.test.mjs](../packages/cli/test/cron-preboot-restore.test.mjs),
and [background-snapshot.test.mjs](../packages/cli/test/background-snapshot.test.mjs).
Kubernetes backup/restore call the shared
[scheduled-history guard](../packages/cli/src/recovery/queue-safety.mjs); this
refusal does not qualify Kubernetes scheduled recovery.

## Public selection and evidence provenance

The public-selector scenario ran in an isolated checkout while main admission
remained closed. Its parsed catalog differed only in admission status, with the
same immutable image, native programs, and source map proposed for promotion.
The run started at `0c28261` with the proposed driver, helpers, and test changes
uncommitted. The introducing commit retains those recorded bytes unchanged; the
promotion tree is checked against the executed archive, including the qualified
catalog. The actual process exited zero after 772.02 seconds. The independent audit checked
637 recorded and archived source files, 132 static imports, 65 image files,
32 fresh native signatures plus 32 altered-signature refusals, three retained
controller artifacts, all 24 volumes, 315 source archive entries, and 90 physical
entries under the retired prefix. It independently rejects modified verifier
helpers and optimized Python that would disable assertions.

Ordinary CLI commands cover enrollment, TLS import, scoped deploy, exact approval,
pause/resume, backup, restore, retirement, and installed startup. Controlled
no-build Compose starts only storage and native nodes for the pre-controller cold
hold checks. Initial network placement comes from an operator-supplied Compose
template; restored placement uses `--network-plan`. These controls are identified
separately from the ordinary operator steps.

The stock fixture uses `retry-once`. In the recorded run this binary reran both handlers on expression-level retry:
inventory records two attempts and one deduplicated callback; advisory
records two attempts and no deduplicated callback. Each retains exactly one saved
result for its occurrence. Last attempt time can therefore follow original
completion time. The audit checks the actual row keys and counts rather than
assuming callback order or exactly-once dispatch. These callback counts describe
this profile, not a universal scheduler guarantee.

Historical selected receipts retain their executed revisions and source boundaries.
All use the same frozen runtime/controller programs; current catalog verification
matches all 63 shipped source pins. Host CLI recovery-volume exclusion and explicit
network placement were added after the earlier profiles and exercised by the
public-selector check. Earlier activation/matrix/recovery runs retain fingerprints,
not complete source archives. The sequential retirement inventory discloses two
omitted static helpers; later dual-cron and public-selector inventories cover their
imports. Static import parsing excludes dynamic code and dependency caches. Copied
cached `node_modules` bytes are not exhaustively inventoried, and the dependency
seed and native rebuild are not claimed reproducible from this evidence.

Raw credentials and runtime observations stay in ignored private evidence. Public
receipts contain selected measurements, fingerprints, and verifier identities;
they do not constitute a public archive of every raw input.

## Admission and remaining scope

Select the family explicitly through the
[runtime installation guide](runtime-selection.md). Keep exact-artifact approval,
app-scoped deploy credentials, independent source identity for recovery, and the
acknowledgment/resume boundary. An unreachable member prevents pause confirmation;
surviving native work can continue until the member returns and pause is retried.
Related-project and volume checks are local observations, not a global writer fence.

No per-worker CPU quota or CPU-exhaustion qualification is claimed. Historical
[watchdog evidence](evidence/m11c-cron-timeout.json) records its own binary and
settings; the [shorter operation-deadline profile](evidence/m11c-cron-operation-deadline.json)
rejects a universal six-callback claim. These do not replace the frozen runtime's
native success/failure evidence.

Workflows, general Durable Object alarms, combined cron/queue applications, three
fleets, expansion, Kubernetes scheduled recovery, other architectures, and remote
or hosted execution remain outside this acceptance. The controller and MinIO remain
single points of failure. Runtime distribution, ordinary diagnostics, artifact
retention, and measured density/serving behavior are the next
[operator-readiness priorities](roadmap.md#immediate-priorities).
