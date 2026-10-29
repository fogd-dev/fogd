# V5 acceptance: an owned local application cloud

`celld-durable-v5-linux-arm64` is qualified for explicit selection on fresh local
Linux arm64 Docker installations: two application fleets, two native nodes per
fleet, MinIO and workerd ingress. It adds durable HTTP route authority, safe retry
after committed migrations and independent HTTP/background resume controls. The
[admission receipt](evidence/operator-v5-admission.json) records the decision and
actual public-catalog installation check.

Default installations retain closed cron admission. Existing family image and
program pins are unchanged. Cross-family migration remains refused; there are no
existing user installations to migrate. Retained installations are QA fixtures.

## Release requirements

The rows follow [operator-readiness](operator-readiness.md#next-runtime-release)
and the [serving-authority release boundary](serving-authority.md).

| Requirement | Evidence and accepted boundary |
| --- | --- |
| Declared source build | [Source build](evidence/operator-durable-v5-source-build.json) records pinned inputs, uncached output, nine native tests and strict Clippy. The [recipe map](evidence/operator-v5-clean-recipe-evidence-map.json) connects unchanged machinery/native inputs to the earlier clean-engine build. The v5 attempt used an existing builder; image digest reproducibility is unproven. |
| Independent installation | [Actual catalog](evidence/operator-v5-admission.json) covers public export/import, received operator/client, scoped approval, update, pending-code isolation, restart, stopped backup and fresh same-family restore on another existing engine on the same physical Mac. App dependencies are prepared prerequisites. |
| Serving and crash authority | [Write checks](evidence/operator-native-write-serving-v5.json) retain 14,842 acknowledged writes in first ledger reads. Activation includes 20 unacknowledged 503s. [Publication](evidence/operator-v5-publication-evidence-map.json) and [finalizer](evidence/operator-v5-retirement-evidence-map.json) maps delimit reused mechanisms; direct v5 checks cover changed migration and dispatch behavior. Required holds, private/public authority, unknown outcomes and non-replay remain explicit. |
| App-scoped diagnosis | [Diagnostics](evidence/operator-native-diagnostics-v5.json) covers two apps, distinct private configuration, failed/corrected handlers, unavailable replicas and private owner log capture. Native readiness is separate from app health; submitter-facing logs are outside this release. |

## Scheduled-work requirements

These rows correspond to all nine [M11c requirements](m11c.md#required-behavior-and-evidence).

| Gate | Evidence and accepted boundary |
| --- | --- |
| 1. Inert upload; schema/secrets before callbacks | [Activation](evidence/operator-native-cron-activation-v5.json) observes unpublished and held-migration minutes. The [matrix](evidence/operator-native-cron-activation-matrix-v5.json) interrupts native resume and durable release, retaining pinned approval and held dispatch. |
| 2. Exact approval and explicit uncertainty | Activation refuses changed secret revisions and alternative held approvals; exact retry remains explicit. [Committed-SQL retry](evidence/operator-native-migration-retry-v5.json) and [SQL rollback](evidence/operator-native-migration-rollback-v5.json) distinguish committed migration from ordinary ledger-insertion failure. Neither claims a crash inside native SQL. |
| 3. Dispatch distinct from HTTP | [Unreachable-member pause](evidence/operator-native-unreachable-pause-v5.json) preserves unknown intent and continued work until explicit confirmed pause after rejoin. [Replacement](evidence/operator-native-compatible-replacement-v5.json) permits already-running work to finish under a dispatch hold. Recovery covers native restart; pause does not drain arbitrary callbacks. |
| 4. Compatible overlap and lost acknowledgment | Replacement verifies old work committing under the compatible schema before publication, unfinished interrupted work through generation release, and original-occurrence retries with one business row per job. Later healthy ticks do not replay abandoned occurrences. |
| 5. Native failures and timing | [Lifecycle](evidence/operator-native-background-v5.json), [owner/waker loss and downtime](evidence/operator-native-background-failures-v5.json), and [sparse terminal retry](evidence/operator-native-cron-terminal-v5.json) cover success, thrown failure, noRetry, eviction/owner loss, six sparse attempts and skipped ticks. No complete missed-tick backlog is promised. |
| 6. Status, outcomes and privacy | Diagnostics and replacement distinguish control state from saved/unfinished app work. Private-value scans cover recorded public surfaces. Runtime injection, raw logs and recovery archives remain private operator data. |
| 7. Held recovery | [Due/retry/older recovery](evidence/operator-native-background-full-recovery-v5.json) verifies cold and acknowledged holds, explicit future resume and queued survivor input. Older recovery requires possible-loss acknowledgment; post-snapshot results can be lost and external effects can replay. |
| 8. Retirement and fresh authority | [Sequential](evidence/operator-native-background-retirement-v5.json) and [dual-cron](evidence/operator-native-background-retirement-dual-v5.json) checks cover survivors, reuse and zero-live recovery. The finalizer map covers unchanged interruption mechanisms. [Family refusal](evidence/operator-v5-family-refusal.json) rejects unsupported migration before allocation. |
| 9. Offline builds and checked topology | [Offline builds](evidence/operator-native-offline-builds-v5.json) and replacement use ordinary Void/fogd builds with networking disabled and read-only engine-local sources, then execute on v5. [SDK preparation](evidence/operator-v5-offline-sdk-preparation.json) uses networking separately. Native identities, artifact/SQL hashes and authority stores are independently checked. |

## Evidence and limits

The final audit rehashes 329 private evidence members across 25 receipt/run entries,
17,359 archived source files and all 109 shipped runtime program pins. It reads old
tracing evidence without executing tracers. The publication map identifies five
unavailable original temporary harness files; it does not claim they were
reverified. Failed and uncertain attempts remain retained and unaccepted.

Select v5 explicitly using the [installation guide](runtime-selection.md).
Same-family stopped recovery requires independent source identity, fresh target
storage and explicit acknowledgment/resume. Routing pause and dispatch pause are
separate decisions. The controller and MinIO remain single points of failure.

This release does not qualify per-worker CPU quotas, exactly once external effects,
broad density, another physical machine, combined cron/queue apps, Workflows,
general Durable Object alarms, expanded scheduled fleets, Kubernetes scheduled
recovery or hosted Cloudflare execution. Those require separate work and evidence.
