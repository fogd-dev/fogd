# M11a acceptance: bounded Docker queues

M11a is locally qualified for the [single-queue Docker profile](queue-admission.md).
Admission remains a supported operator opt-in, `FOGD_QUEUE_APPS=1`; the default is 0.
This closes the queue slice, not M11's scheduled/workflow or live-session capabilities.

| Requirement | Evidence and scope |
| --- | --- |
| Acknowledgment, completion, terminal failure, explicit retry | [Ordinary CLI app run](evidence/m11a-queue-public.json), including 202 and expected result rows |
| Saved job URL, reload and retryable failure | [Chromium through workerd](evidence/m11a-queue-public-browser.json), without request interception |
| Duplicate delivery without duplicate business records | [Two queued messages through restore](evidence/m11a-queue-public-recovery.json); queue drains, unique database rows remain |
| Separate retained input, D1 record and queue send | [Example contract](../examples/imports/README.md) and jobs unit tests; explicit retry repairs a failed send, no atomic enqueue claim |
| Scoped submit, exact approval, preapproval inactivity | [Public admission](evidence/m11a-queue-public.json); no owner or deploy objects, wrong digest refused |
| First-deploy migrations before app consumer | [Bootstrap coordinator](queue-activation.md), [built-controller probe](evidence/m11a-activation.json), and canonical first approval |
| Additive migration with pending and in-flight work | [Canonical update](evidence/m11a-queue-public-update.json); v2 completes pending work while v1 runs, one attempt each |
| Consumer failure/restart | [Native Void process-loss probe](evidence/m11a-native-imports.json) plus canonical handler exceptions/retry; process kill remains direct-runtime evidence |
| Controller failure at activation boundaries | Process-kill activation tests and [canonical interrupted update](evidence/m11a-queue-public-history.json) |
| Stopped recovery with pending work | [Canonical restore](evidence/m11a-queue-public-recovery.json); HTTP gate, acknowledgment, preserved pause and explicit resume |
| Existing three-app isolation | [Three-fleet retirement evidence](evidence/m11a-queue-retirement-complete.json); private artifacts, separate from the two-fleet canonical runs |
| Retained retired queue cannot run in replacement | [Populated canonical retirement](evidence/m11a-queue-public-populated.json); byte hashes, fresh prefix, retired 404, neighboring post preserved, replacement database empty |
| Same source builds for both targets offline | [Network-disabled verifier](evidence/m11a-offline-builds.json); typecheck, ordinary Void build, fogd build, canonical queue staging |

The [Claude audit](reviews/m11a-acceptance-claude.md) found two open checks at its
inspection time. The populated retirement rerun and network-disabled imports build
above close them. Lower-level process-loss and three-fleet evidence remain labeled;
we do not describe every requirement as one canonical end-to-end run.

The opt-in is deliberate policy. Activated or retired queue history prevents Docker
expansion and Kubernetes recovery. Turning admission off does not pause approved
consumers. Paused messages still age against upstream retention; compatible old
handlers can finish after pause or update. See [recovery](queue-recovery.md) and
[delivery controls](delivery-controls.md). These limits are not default-enablement
TODOs hidden behind an experimental flag.

The earlier failed-claim snapshot with two exit-143 replicas was backed up but not
restored. A later current-image snapshot and canonical pending-work snapshot were
restored successfully. That specific crash-recovery bundle remains unqualified;
it is not required evidence for this bounded closeout.
