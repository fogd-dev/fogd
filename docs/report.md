# fogd implementation report

fogd runs supported Void applications on infrastructure you control, with an
integrated build/deploy workflow and operator approval. Today it has qualified
local Docker flows for stateful apps, private configuration, recovery, bounded
queues and live sessions. Kubernetes evidence is experimental and local. Remote
infrastructure, scheduled app lifecycle, Workflows and broader portability remain
open work.

The [north star](vision.md) is a complete application platform with the freedom to
choose where applications live. FilOz demo hosting is one candidate first use case,
not the scope of the product. The [product scenarios](product.md) and
[roadmap](roadmap.md) connect that vision to testable outcomes.

## What developers and operators can do

A developer builds a supported Void app and submits it with the workspace
`fogd deploy`. An operator reviews the immutable artifact digest and approves its
activation. Named, app-scoped credentials separate upload authority from approval.
The app receives hostname routing and declared resources. Operators supply private
configuration, inspect deployment state, retry failed activation, back up a stopped
installation and retire apps through documented procedures.

The expanded CLI has not been published to npm; use this checkout's workspace CLI.
The [README](../README.md) contains setup and milestone reproduction instructions.
No Cloudflare account, credentials or API calls are used by these qualifications.

| Capability | Current evidence and boundary |
| --- | --- |
| Core deployment and approval, M1–M6 | D1 starter and D1/R2/DO notebook; two approved apps, routing, rejection and restart recovery. [Architecture](architecture.md), [README](../README.md) |
| Native full-stack Void, M7a | Guestbook UI, typed API/forms, assets, additive SQL and updates; [fixture guide](../examples/guestbook/README.md). Fresh-agent onboarding passes; human participation is not a gate |
| Application growth, M7b | Additive R2 bindings and a bounded logical message/attachment transfer profile; [transfer guide](../examples/guestbook/TRANSFER.md) |
| Configuration and identity, M7c | Revision-pinned secrets and a bounded native email/password flow, with an explicit scrypt adapter; [accounts guide](../examples/accounts/README.md) |
| Installation recovery, M8a | Stopped, coordinated backup and fresh-volume restore; interrupted activation and continued writes; [recovery guide](recovery.md) |
| Shared-operation controls, M8b | Scoped deploy credentials, admission quotas, native HTTPS and private listeners; [access](deploy-access.md), [shared installation](shared-installation.md) |
| Kubernetes, M9 | Local kind deployment, pod replacement and stopped fresh-PVC recovery; [installation](kubernetes.md), [recovery](kubernetes-recovery.md). Actual remote-host failures remain unqualified |
| Capacity and retirement, M10 | Qualified Docker layouts through three app fleets, capacity reporting, stopped expansion/retirement and retained-state isolation; [capacity](capacity.md), [expansion](expansion.md), [retirement](retirement.md) |
| Background queues, M11a | Bounded Docker opt-in, disabled by default; native Void import flow, activation controls, retries, duplicate handling and recovery; [acceptance](m11a-acceptance.md) |
| Live sessions, M11b | Bounded native WebSocket/SSE lifecycle, lost-ack reconciliation, owner/gateway failures, compatible replacement, movement and stopped restore; [acceptance](m11b-acceptance.md). Pinned Void patches and the opt-in celld candidate are required |
| Scheduled work, M11c | Bounded native profiles, sealed recovery and selected guarded release activation interruptions have evidence; cron admission remains closed. [Contract](m11c.md), [recovery](cron-sealed-recovery.md), [activation](cron-sealed-activation.md) |
| Broader portability, M12 | Offline ordinary Void/fogd builds and bounded logical transfer already exist. General target migration and non-Void Workers import remain open |

## How the system is arranged

workerd handles hostname routing; each complete app and its stateful bindings run
in a separate celld fleet. Qualified Docker layouts use two persistent replicas per
app. Keeping bindings with their app avoids a cross-runtime emulation bridge.
The fogd controller owns approval, resource identity and activation. It replaces
the Cloudflare provisioning path; it does not host Void Platform unchanged.

Bucket-backed state does not make node disks disposable. Recovery preserves the
bucket, controller metadata, replica identities and witness logs together. Stable
node names and peer addresses matter. A bucket copy alone is not a supported
installation backup. Physical recovery and logical application transfer are
separate contracts.

The [source-pinned compatibility matrix](compat.md) distinguishes upstream runtime
features from fogd admission. The [feature table](features.md) compares fogd, celld,
workerd, Void and hosted Cloudflare. Dynamic loading does not establish a standalone
Workers-for-Platforms dispatch service. Unsupported nonempty declarations fail
explicitly in the [artifact adapter](../packages/runtime/src/artifact.mjs).

## Material limits

- The trust boundary is reviewed application code. These fleets, shared storage
  credentials and operator interfaces are not a hostile-tenant sandbox. Controller
  and MinIO availability remain installation dependencies; this is not global HA.
- Qualified capacity is a small, fixed Docker layout. There is no automatic fleet
  scheduler, autoscaling, DNS/certificate provisioning or proof of remote two-host
  operation. Local kind tests do not establish production Kubernetes support.
- The database profile is one D1 database per app with primary sessions. R2 put/get
  and additive declarations are tested; multipart handles are not portable across
  replica processes. D1/DO resource additions and general resource deletion remain
  unsupported. Other framework paths and full Void SDK coverage need qualification.
- Routing pause is not a drain or revocation of established sockets, in-flight
  requests or existing DO alarms. Migrations must remain compatible with overlapping
  handlers. There is no automatic schema rollback.
- Queue admission is an explicit Docker opt-in. Activated or retired queue history
  still prevents Kubernetes recovery and expansion. Queue pause does not cancel
  effects already in flight; see [queue recovery](queue-recovery.md).
- Preserved-socket replacement fails on the stock pinned celld runtime. The opt-in
  patch qualifies the documented local slice, not upstream acceptance. SSE hints
  have no delivery or network-order guarantee. Older-state detection covers lower
  revisions, not equal-or-higher divergent histories.
- Injected secret values stay outside submitted artifacts but exist in plaintext
  in celld's bucket. The supported auth flow does not cover every provider or
  production identity operation. Runtime limits and admission quotas do not provide
  per-request billing or isolation for arbitrary untrusted code.
- Cron admission, Workflows, general DO alarm lifecycle, AI/dispatch bindings and
  broader resource APIs remain open. Offline builds do not prove hosted Cloudflare
  behavior or a completed migration path. Filecoin integration remains deferred.

## Decisions and next work

The [decision log](decisions.md) records the reasoning behind each boundary. The
major choices are complete apps in celld, workerd ingress, separate persistent app
fleets, exact-artifact approval, stable replica identities, compatible migrations,
coordinated stopped recovery and explicit opt-ins for capabilities requiring extra
lifecycle controls. Void's integrated SDK experience remains the first development
path; compatibility is verified through concrete app and failure scenarios.

M11c keeps native Void/celld scheduling and adds durable dispatch controls instead
of a fogd scheduler. Its first app-free D1 bootstrap foundation passes tests. The
[native retry negative control](evidence/m11c-cron-retry-negative.json) confirms a
runtime defect. A source-pinned candidate preserves the failed expression and
original occurrence after owner loss in a two-node runtime probe. The
[watchdog evidence](evidence/m11c-cron-timeout.json) records its terminal callback
set and actual future dispatch. The [native hold candidate](patches/celld-cron-controls.md)
passes bootstrap/adoption and restart checks, including a callback that finishes
while its sibling is suppressed. These are runtime experiments. Native
[clippy passes](evidence/m11c-cron-rust-checks.json); actual upstream Rust test
execution and CPU-exhaustion qualification remain open. An internally staged
[activation coordinator](cron-activation.md) has file-backed interruption tests and
a native D1/secret bootstrap, lost-resume reload and paused-update profile. The
[Void refresh fixture](../examples/refresh/README.md) also passes its bounded native
workerd flow: two jobs share an expression, use separate ledgers when that expression
retries, retain a visible prior success during failure and deduplicate after a
simulated lost reply. Offline builds cover ordinary Void and fogd. The
[operator controls](cron-controls.md) add authenticated recorded status, observe,
pause and artifact-pinned resume with native lost-reply reconciliation. Selected
[native controller SIGKILL cuts](cron-activation.md#native-process-interruptions)
cover publication, resume and durable release, including a paused update and
explicit artifact-pinned retries. [Stopped recovery](cron-recovery.md) qualifies
due timers, pending retries and an older snapshot in a same-version local two-fleet
Docker profile. Its full rerun independently verifies queued input, restored
approval pins and final source preservation. [Retirement](retirement.md#experimental-scheduled-app-retirement)
has separate bounded cron/queue and [two-cron](retirement.md#retirement-beside-another-scheduled-app)
profiles, including a held survivor and source restore of both schedules. Normal
scoped cron admission and release-bound runtime qualification remain open.
The [early identity candidate](patches/celld-runtime-identity.md) independently
reports the actual native executable before first deployment. Its metadata profile
passes four new Linux Rust tests and a disposable native drill with unchanged
bucket contents. All 179 embedded source files match the applied patch stack.
These tests do not execute upstream internal suites, and this new binary does not
inherit earlier cron lifecycle qualification. The
[caller policy foundation](cron-runtime-policy.md) verifies a supplied profile
before bootstrap and every cron command, with native app-free refusal and held-cell
evidence. The
[signed release-profile foundation](patches/celld-runtime-binding.md) adds
storage-origin/region claims and fresh lease-key possession proofs. Its app-free
qualification includes nine native Rust tests, 498 repository tests and separate
bootstrap/live-lease command checks. General runtime lifecycle fencing,
shipped-runtime selection and the remaining scheduled lifecycle qualification on
this binary remain open.
The [host preboot foundation](cron-runtime-preboot.md) now validates an independent
runtime/storage launch policy before experimental restore creates application
containers. Its app-free native profile checks image/program identity and
read-only startup. Normal CLI cron restore and retirement refuse all scheduled
history. The [sealed scheduled recovery profile](cron-sealed-recovery.md) qualifies
due/retry/older snapshots, explicit acknowledgment/resume and a queued survivor on
this release binary and layout. Independent acceptance checks verify native
signatures, the approved artifact and all retained source files. A qualified-runtime
registry, the remaining release-runtime lifecycle and ordinary admission remain
open; historical receipts retain their pinned-source scope.
The [guarded activation profile](cron-sealed-activation.md) adds four actual
controller SIGKILL cuts with hold-only restart and explicit approval retry. It
checks durable approval/secret pins, paused updates and retained business results.
Independent acceptance verifies native signatures, image layers and all three
retained artifacts. This is direct controller qualification; normal admission and
the external admin/TLS activation flow remain open.

Workflows/general alarms, remote infrastructure and M12 portability follow
their own acceptance contracts.

The [historical report](report-history.md) preserves detailed checkpoint narratives.
Current acceptance documents and `docs/evidence/` contain the scoped proof; an
older passing checkpoint does not establish later or broader behavior.
