# V9 acceptance: retain apps and reuse owned capacity

`celld-archive-v9-linux-arm64` is qualified for explicit selection on fresh local
Linux arm64 classic-overlay2 Docker: two application fleets with two native nodes
each, MinIO and workerd ingress. It adds stopped app archival/restoration, reserved
names, reviewed capacity changes and explicit owner recovery to the
[v8 operating boundary](operator-v8-acceptance.md). The
[admission receipt](evidence/operator-v9-admission.json) records the source audit
and actual qualified-catalog installation check.

Default installations keep cron admission closed. Earlier family pins stay
unchanged; v6 and v7 remain closed. Cross-family migration is refused. There are no
existing user installations to migrate; retained installations are QA fixtures.

## Release requirements

Compared with v8, 93 program inputs are unchanged, 24 differ and 13 are added.
Every runtime-package input, the native binary, supervisor, storage image, root
locks and operator dependency inputs are unchanged. Changed controller/startup,
policy, archive and restoration integrations have current source/native evidence.
The audit rechecks retained evidence and source files without executing archived
programs or tracers. Evidence reuse is distinct from new experiments.

| Requirement | Evidence and accepted boundary |
| --- | --- |
| Declared build | The inherited v5 clean source recipe and v8 admission chain remain verified. Two matching uncached COPY-only v9 builds use v8 as their parent. The audit checks image ancestry, actual binary/supervisor bytes and all 130 current program inputs. This is not a new native rebuild or image-digest reproducibility claim. |
| Independent installation | The [private versioned preparation](evidence/operator-archive-v9-release-preparation.json) starts with an empty recipient engine and authenticated operator/client bundle. The [received recovery check](evidence/operator-archive-v9-received-recovery.json) performs actual reviewed archive/restoration commands and owner approval. The admission receipt adds unmodified qualified-catalog export/import, fresh TLS enrollment, scoped submission, exact approval, empty initial app data, a D1 write and restart. Source and recipient engines share one physical Mac; app dependencies are prepared prerequisites. |
| Serving authority | A direct v9 controller-only outage retains gateway reads and an acknowledged D1 write during a measured twenty-second interval. The admission receipt retains the samples and corrected diagnostic assertion. Gateway/route-record inputs are unchanged; v5 write/publication/crash evidence remains inherited. Uninterrupted updates, failover and power loss are not qualified. |
| App-scoped diagnosis | Direct received v9 observation distinguishes verified native facts from uncertain readiness while the controller is stopped, then confirms readiness after rejoin. Two private replica log captures verify owner-only permissions. Earlier v7 failure/correction and unavailable-replica checks apply to unchanged diagnostic mechanisms; current archive-aware diagnostics deliberately avoid probing archived/pending apps. |

The actual qualified-catalog rehearsal compares every non-documentation operator
program/configuration file and the developer-client manifest with the preceding
private proposal. All 463 such operator files and the client manifest are identical.
The broader proposed-release update and archive/recovery workloads are reused on
that explicit basis; they are not represented as repeated actual-release workloads.

## Scheduled-work requirements

These rows map all nine [M11c requirements](m11c.md#required-behavior-and-evidence).
Native scheduling, activation and publication mechanisms remain unchanged.
Archive-aware guards and restoration projections have separate current evidence.

| Gate | Evidence and accepted boundary |
| --- | --- |
| 1. Inert upload; schema/secrets before callbacks | Inherited v5 activation cuts and v7 complete lifecycle cover held minutes, publication and migration boundaries. Current v9 queue/cron sources and received ordinary client tests exercise fixed archive startup, exact approval, SQL and secrets through the changed controller integration. |
| 2. Exact approval and uncertainty | Unchanged activation and default review verification retain v6 browser stale/tampered/failure and v5 migration-retry/rollback evidence. Current tests cover decision write failure and archive selection/review refusal. Native original-pin and current-vault rotation approvals retain pending execution until separate recovery controls. |
| 3. Dispatch separate from HTTP | Inherited held-callback, unreachable-member and controller-loss checks retain their scope. Current v9 native cron recovery crosses a minute with no invocation; queue input remains held. Independent acknowledgment and background resume are required. Pause does not drain arbitrary callbacks. |
| 4. Compatible overlap and lost acknowledgment | Native scheduler and activation bodies are unchanged. Inherited v5 compatible overlap/lost-acknowledgment and v7 original-occurrence retry checks retain their application idempotency limits. |
| 5. Native failures and timing | The identical native binary/supervisor retain autonomous success, thrown failure, noRetry, retry/owner loss, downtime and terminal-retry evidence. Current v9 cron sources and restored peers also produce autonomous future invocations. A complete missed-tick backlog is not promised. |
| 6. Outcomes and privacy | Current CLI/native checks distinguish pending code, recorded decisions, native readiness and actual app data. Secret values/private versions stay out of review/approval replies. The v9 controller-loss check preserves readiness uncertainty while serving works; private logs remain owner-only. Earlier browser/example outcome checks are inherited. |
| 7. Held recovery | Current whole-snapshot, queue/cron archive, secret rotation, mixed-peer and received-operator checks verify fresh stores, retained history/times, withheld cold starts and explicit approval/acknowledgment/resume. Inherited v5 due/retry/older-snapshot checks cover unchanged timer/queue semantics. Older snapshots can lose results or replay external effects. |
| 8. Retirement and fresh authority | Unchanged native retirement mechanisms retain v5/v7 sequential, dual-cron, zero-live and history evidence. Current archive checks reserve names, release only verified logical capacity, preserve surviving apps and restore only into unassigned fresh storage. Unsupported topology remains refused. |
| 9. Offline builds and topology | Native binary/supervisor, all runtime-package inputs and root locks are unchanged. Inherited ordinary offline Void/fogd fixture builds retain their recorded dependency prerequisites. Current received-client builds and native two-node deployments use the declared local topology. Hosted Cloudflare is unqualified. |

## Archive and owner workflow

The [archive command reference](archival.md) describes stopped planning/execution
and owner recovery. Reviews bind independent source identities, snapshots, release,
archive identity and target/network selection before allocation. Both sources and
related writers stay excluded during restoration. Retained snapshot-member bytes,
zero disk reclamation and conditional logical fleet capacity are separate fields.

The native D1/R2, whole-installation, secret-rotation and mixed queue/cron peer
checks retain original app data and later peer writes through restart. Current
vault credentials govern recovery; old source secrets are not a fallback. Owner
approval leaves execution held. HTTP-only apps need explicit routing resume;
background acknowledgment restores HTTP while leaving delivery/dispatch paused.

Native coordinator and command matrices cover lost copy/route/fence replies,
competing archive/restoration/startup and interruption of owned Node command
processes after an actual replica copy or before result emission. Incomplete
targets remain unlaunchable. A completed storage operation with no confirmed
command result is not reported as a completed command. Partial resources and
source fences remain retained; no automatic reset or replay repairs an observer.

Known harness failures remain unaccepted. Their read-only reconciliation and
continuation of unexecuted actions are identified in the receipts. In particular,
archive-pending observation is deliberately inert; waiting for its replica probes
was a harness error. Controller-loss observation correctly reports `not-running`
and uncertain readiness, not confirmed readiness from healthy replicas alone.

## Limits

This acceptance does not qualify another physical machine, remote/privileged writer
fencing, power loss, per-worker CPU quotas, broad density/performance, exactly once
external effects or uninterrupted updates. Controller and MinIO remain single
points of failure. Live slot reuse, automatic data erasure and unlimited app density
are unsupported. Queue and cron handlers combined in one app, Workflows, general
Durable Object alarms, expanded scheduled fleets and Kubernetes scheduled recovery
remain outside this boundary.

Use [same-family recovery](recovery.md) with independent identity and fresh target
storage. There is no cross-family adoption or migration. Image/download/npm
publication and unaided human onboarding are separate work. Local `0.3.0` bundle
receipts do not imply an official published download or registry release.
