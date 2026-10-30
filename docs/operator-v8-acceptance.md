# V8 acceptance: review and operate an owned application cloud

`celld-approval-v8-linux-arm64` is qualified for explicit selection on fresh local
Linux arm64 Docker installations with the classic `overlay2` image store: two
application fleets, two native nodes per fleet, MinIO and workerd ingress. It adds
verified browser release comparisons and attributed administrator decisions to the
v5 operating boundary, including artifact cleanup that retains decision history.
The [admission receipt](evidence/operator-v8-admission.json) records the decision
and actual qualified-catalog installation check.

Default installations retain closed cron admission. Earlier image and program
pins stay unchanged; v6 and v7 remain closed candidates. Cross-family migration
remains refused. There are no existing user installations to migrate; retained
installations are QA fixtures.

## Release requirements

These rows follow [operator readiness](operator-readiness.md#next-runtime-release)
and the [v5 acceptance boundary](operator-v5-acceptance.md). Evidence reuse is
explicit: v8 retains the native binary, supervisor, storage image, root dependency
inputs and 103 v5 program files. Six earlier program inputs differ and eight are
added. The v6 review/controller executable bodies are unchanged apart from v8's
artifact-retention correction; package metadata also differs.

| Requirement | Evidence and accepted boundary |
| --- | --- |
| Declared build | [V5 source build](evidence/operator-durable-v5-source-build.json) and its clean-recipe map establish the inherited native inputs. [V8 packaging](evidence/operator-approval-v8-candidate.json) records two matching uncached COPY-only builds. The admission audit independently rehashes the actual native binary, supervisor and all 117 current program inputs, and checks image ancestry. This is not a new clean native rebuild. |
| Independent installation | The [versioned rehearsal](evidence/operator-v8-versioned-pruned-recovery.json) begins with an empty engine and authenticated operator/client bundle. The admission receipt adds actual qualified-catalog export/import, fresh TLS enrollment, scoped deployment, update, restart, stopped backup and fresh restore on a distinct existing engine. All engines share one physical Mac; app dependencies are prepared prerequisites. |
| Serving authority | V5 write, publication and crash evidence applies to unchanged gateway and activation mechanisms. Direct v7 diagnostics verify serving both apps during controller loss. Controller decision integration has native browser failure/retry and background lifecycle checks; these do not promise uninterrupted updates. |
| App-scoped diagnosis | The v7 diagnostic audit in the v8 candidate receipt covers failed/corrected handlers, unavailable replicas, withheld routing, controller loss and six private log captures. Native readiness stays separate from app outcomes. Shared submitter-facing logs remain outside this boundary. |

## Scheduled-work requirements

These rows cover all nine [M11c requirements](m11c.md#required-behavior-and-evidence).
The v5 acceptance audit links the individual inherited runs. Their unchanged
mechanisms and dependencies are rechecked; old failure experiments are not rerun
or represented as fresh v8 tests.

| Gate | Evidence and accepted boundary |
| --- | --- |
| 1. Inert upload; schema/secrets before callbacks | Direct complete v7 lifecycle checks inert upload, exact secret approval, compatible SQL/cadence update and stopped snapshot. V5 activation and interruption matrices cover unchanged migration/dispatch mechanisms. |
| 2. Exact approval and uncertainty | V6 native browser stale/tampered refusal, failed SQL and corrected exact retry exercise the unchanged review/controller bodies. Canonical tests cover new decision intent/outcome write failures, fencing and reload without replay. V5 committed-SQL retry and rollback evidence retains its original limits. |
| 3. Dispatch separate from HTTP | Direct v7 lifecycle retains a confirmed pause through controller loss and checks scheduled/queued work with HTTP withheld. V5 unreachable-member and held-callback checks cover unchanged native controls. Pause does not drain arbitrary callbacks. |
| 4. Compatible overlap and lost acknowledgment | Direct v7 original-occurrence retry produces one business row per job. V5 overlap/lost-acknowledgment checks cover unchanged execution and publication mechanisms. |
| 5. Native failures and timing | Direct v7 success, thrown failure, noRetry and retry observations supplement the unchanged native scheduler's v5 owner/waker-loss, downtime and six-attempt terminal checks. No complete missed-tick backlog is promised. |
| 6. Outcomes and privacy | V6/v7 browser and diagnostic checks distinguish recorded decisions, native readiness and app outcomes. V8 pruning validates history and protects unfinished decisions. Private logs and recovery material remain private operator data. |
| 7. Held recovery | V6 paused cron/queue restore retains history with explicit acknowledgment/resume. Its executable bodies differ from v8 only in retention classification; v5 due/retry/older recovery covers unchanged scheduling paths. Direct v8 fresh HTTP recovery retains combined history/prune metadata and requires native-verified HTTP resume. Older snapshots can lose results or replay external effects. |
| 8. Retirement and fresh authority | V7 native retirement retains history, survivor data and fresh namespace reuse. V5 sequential/dual-cron retirement, zero-live recovery and family refusals cover unchanged fencing and native storage mechanisms. V8 pruning removes terminal artifact bytes without deleting deployment or decision records. |
| 9. Offline builds and topology | Root locks, SDK inputs, native binary, supervisor and scheduler remain unchanged. V5 ordinary offline Void/fogd fixture builds and native two-node checks supply the inherited evidence. Hosted Cloudflare execution is unqualified. |

## Verified release review and history

The browser verifies proposed and active artifacts before showing file, resource
and SQL comparisons. Exact submission, digest, secret revision and a controller-bound
review context bind decisions. Native v6 tests cover stale and tampered refusals,
failed activation, corrected retry and two-app isolation; v7 verifies matching
packaging and browser approval. Those review bodies are unchanged in v8.

Authenticated decisions record the configured Basic credential, action, identity
and outcome. Shared credentials identify credentials rather than individual humans.
Intent precedes effects; uncertain outcomes never replay automatically. Authentication,
CSRF protection, escaped content and withheld private diagnostics retain their
source and native checks. All 2,887 canonical tests pass at the v8 correction;
the admission change has focused catalog and release/recovery checks.

The v8 retention correction excludes validated completed history from artifact-byte
protection while retaining started/unconfirmed decisions, pins and live/recovery
references. Native audit verifies two terminal artifacts removed, four decisions
retained and both apps' data after restart. The versioned rehearsal then verifies
pruned-state backup and fresh restore: history and prune markers survive, deleted
bytes stay absent, pending code/SQL stays inert and a new durable write succeeds.

## Evidence and limits

The admission audit rehashes retained v5 evidence and source archives, the later
browser/recovery/retirement proofs and current image bytes. It reads archived fault
and tracing evidence without executing archived programs or tracers. Known failed
attempts remain unaccepted. The original v8 prune driver completed native work
and shutdown, then failed at a generic privacy observer; its read-only finalizer
and independent state/snapshot audit remain distinct from that failed driver.

Select v8 explicitly using the [installation guide](runtime-selection.md).
Same-family stopped recovery requires independent source identity, fresh target
storage and explicit acknowledgment/resume. HTTP routing and background dispatch
remain separate decisions. The controller and MinIO remain single points of failure.

This boundary does not qualify per-worker CPU quotas, broad density/performance,
another physical machine, power loss, exactly-once external effects, combined
cron/queue apps, Workflows, general Durable Object alarms, expanded scheduled fleets,
Kubernetes scheduled recovery or hosted Cloudflare execution. Image/download/npm
publication and unaided human onboarding remain separate work. A private proposed
`0.2.0` bundle is rehearsal evidence, not an official published release.
