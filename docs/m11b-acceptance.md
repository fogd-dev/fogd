# M11b acceptance audit: bounded Docker live sessions

M11b is qualified for bounded local Docker live sessions, following the
[requirement audit](reviews/m11b-acceptance-claude.md) and
[closure review](reviews/m11b-closure-claude.md). Native Void WebSocket and SSE
flows require the pinned Void patches and opt-in celld candidate. The default
upstream celld binary fails preserved-socket replacement; this qualification is
not an upstream acceptance claim. General scheduled effects, Workflows, remote
infrastructure and hosted Cloudflare execution remain outside this slice.

| Requirement | Evidence and scope |
| --- | --- |
| Native room, inferred resources, ordinary builds and exact approval | [Transport](evidence/m11b-native-websocket.json), [server protocol](evidence/m11b-board-protocol.json), and [offline builds](evidence/m11b-offline-builds.json); native Void APIs with labelled patches |
| Two apps, room separation, no upgrades before approval | App/room separation in server protocol and [SSE isolation](evidence/m11b-sse-failure.json); [fresh-app refusal](evidence/m11b-approval.json) covers browser failures and HTTP 404 before approval, then 101 and durable edits after exact approval |
| Concurrent edits, receipts, conflicts, typed rejections and retry identity | Server protocol plus [browser evidence](evidence/m11b-browser.json); SQL transaction/rollback/capacity checks in `examples/checklist/test/board.test.mjs`, browser storage and terminal-capacity handling in `session.test.mjs` |
| Lost acknowledgments and disconnected browser reconciliation | Browser evidence records an intercepted lost ack, retained pending id, actual reload/replay, and unchanged authoritative snapshot; this is a controlled browser fault |
| Owner and gateway loss | [Process failure](evidence/m11b-process-failure.json) and [candidate reruns](evidence/m11b-patched-runtime.json); exact owner identified, committed state recovered through native reconnect |
| Non-owning ingress loss | [Ingress failure](evidence/m11b-ingress.json); direct-owner control socket distinguishes ingress loss from owner failure |
| Ordinary idle and actual hibernation | [Idle evidence](evidence/m11b-idle.json); finite 30-second ordinary observation plus explicit five-second eviction, not unbounded idle qualification |
| Healthy ownership movement | [Native balancer](evidence/m11b-move.json); three rooms, persisted owner/epoch changes, 1012 reconnect, receipt replay, receiver snapshots, unchanged processes |
| Compatible replacement, including after eviction | [Patched runtime](evidence/m11b-patched-runtime.json) and [SSE/update rerun](evidence/m11b-sse-patched.json); an existing v1 socket reaches v2 and settles saved v1 work |
| Route pause and new upgrades | [Route pause](evidence/m11b-route-pause.json); established sockets still mutate, new connections are refused; no revocation or migration drain claim |
| SSE registration, resubscription and missed hints | [Initial browser evidence](evidence/m11b-sse-initial.json) plus installed registration patch and twelve regression cases in [patched evidence](evidence/m11b-sse-patched.json); snapshots follow successful registration |
| SSE deployment cancellation and idle | Patched evidence records actual approval, stream error/reopen, accepted resubscription and later v2 snapshot; cancellation setting is a fixture value, not a timing guarantee |
| Publication failure and app isolation | [Publication/isolation drill](evidence/m11b-sse-failure.json); topic-node pause also stalls a log follower, two writes commit through bucket fallback, late hints repair the same observer; separate unit checks cover thrown/rejected publication |
| Complete stopped recovery and lower-revision handling | [Fresh-volume restores](evidence/m11b-restore.json); both apps and receipts preserved, actual older snapshot stops pending writes, explicit acceptance reuses the pending id; equal/higher divergent histories remain undetected |
| Offline retirement contract unchanged | Retirement source comparison since `d3c83c1` in restore evidence; changing routing is not revocation of established streams |
| Same application source for ordinary Void and fogd builds | [Offline builds](evidence/m11b-offline-builds.json) and final patched-package builds recorded in [SSE evidence](evidence/m11b-sse-patched.json); five apps typecheck/build/stage with networking disabled |

The room is an anonymous, local qualification fixture. Its capacities are example
bounds, not platform-wide quotas. It has no membership revocation, durable event
replay, distributed merge protocol or hostile-tenant isolation claim. Pruning alarms
in Void live do not qualify general scheduled effects or Workflows.

Hints are issued after the SQL transaction commits and the acknowledgment is
handed to native send. Network arrival order between hints and output-gated
acknowledgments is not guaranteed; a peer may receive a hint first. Hints carry
only a revision and trigger an authoritative snapshot read. Snapshot GET output
gating is inferred from celld's egress-gate source, not independently measured in
this drill. An uninterrupted observer ignores lower snapshots after seeing a
higher revision; reconnect detects a lower revision, but neither path detects
equal- or higher-revision divergent history. There is no hint-delivery guarantee.

The stopped-recovery record documents edits made to error cleanup after the run
started; those failure branches were not fault-injected. The completed successful
flow and independent cleanup checks are the evidence, not a claim that every failure
in the probe itself was exercised.
