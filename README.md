# fogd

Run Void apps on hardware you own. workerd routes requests; celld runs each app
with D1, R2, and Durable Objects; MinIO stores fleet state. Teammates submit builds
with `fogd deploy`, and an admin approves the exact artifact before it runs.

This local Docker prototype supports two apps by default, or three with a rendered
installation, with two celld replicas each. It is
for trusted, reviewed application code. Compare fogd, celld, workerd, Void, and hosted
Cloudflare in the [feature table](docs/features.md). Read [the report](docs/report.md) for tested
behavior, limitations, and the decisions behind it.

Planning drafts describe the [vision](docs/vision.md), [product scenarios](docs/product.md),
[roadmap](docs/roadmap.md), and [compatibility goals](docs/compatibility-policy.md).
They include optional Filecoin storage and recovery as future work. See the
[Claude/Gemini vision review response](docs/reviews/vision-response.md) for the review
record and subsequent user input. These are proposals, not supported features.

## Start from a clean checkout

Requirements: Docker with Compose, Node.js 24.21 or newer, and pnpm 10.16.1.
Dependencies stay in the workspace. No Cloudflare account, credentials, or API calls
are needed; nothing here publishes npm packages.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm exec fogd up
cd examples/hello
pnpm exec fogd deploy
```

`fogd up` builds the images and creates private admin, submitter, and gateway secrets
in the ignored `.env` file. The first build compiles a pinned MinIO source release
because its upstream images are unavailable. See [.env.example](.env.example) for
ports, bucket endpoints, replica addresses, and resource limits. `docker compose up
-d --build` also works once the three required secrets are configured.

Open **http://localhost:8788**, sign in as `admin` with `FOGD_ADMIN_PASSWORD` from
`.env`, inspect the artifact and migrations, and approve. Then:

```sh
curl -H 'Host: hello.localhost' http://127.0.0.1:8787/api/posts
```

The response is `[]`. Pending and rejected code does not run. Ports bind to loopback;
stop with `docker compose down` to preserve data. Do not delete volumes containing
data you want to keep.

## Milestone 1: compatibility and architecture

[Compatibility](docs/compat.md) maps the Void SDK and Platform to source-backed
workerd/celld support. [Architecture](docs/architecture.md) explains the runtime
boundary. [Decisions](docs/decisions.md) and [architecture review](docs/reviews/architecture-response.md)
record why complete apps stay in celld. No native binding objects cross HTTP.

## Milestone 2: Void starter and D1

`examples/hello` was generated with `npx void init`, selecting D1 and demo code.
The clean-checkout commands above build, submit, approve, and serve it. fogd maps
Vite output to celld's `no_bundle` config and generates workerd capnp service
bindings. See [build output](docs/build-output.md) for the single-module adjustment.

For low-level experiments without the approval controller, `compose.local.yaml`
preserves the original single-app topology. Use a separate Compose project and
port; it is an operator-only diagnostic path. The default stack always uses approval.

## Milestone 3: storage, Durable Objects, migrations, recovery

Deploy the second example and approve its digest in the admin page:

```sh
cd examples/notebook
pnpm exec fogd deploy
cd ../..
curl -H 'Host: notebook.localhost' -H 'Content-Type: application/json' \
  -X PUT http://127.0.0.1:8787/api/entries \
  -d '{"id":"first","title":"Hello","body":"Stored in R2"}'
curl -H 'Host: notebook.localhost' http://127.0.0.1:8787/api/entries
node scripts/recovery.mjs
```

The example stores metadata in D1, bodies in R2, and operation IDs in a Durable
Object. It includes two SQL migrations. Its writes are idempotent across repeated
operation IDs; they are not a transaction across the three bindings.

The recovery check force-stops both replicas in turn, verifies acknowledged data
on the survivor, writes between failures, waits for rejoin, and restarts workerd.
It defaults to `slot-2-a`/`slot-2-b`, assuming hello was approved first. Override
`FOGD_REPLICA_A` and `FOGD_REPLICA_B` if notebook occupies slot 1. Also configurable:
`FOGD_URL`, `FOGD_APP_HOST`. Replica identities, peer addresses, and log volumes must
stay together; [ADR 005](docs/decisions.md) explains why.

## Milestone 4: CLI

`fogd up` starts the stack. `fogd deploy [--name app]` builds with app-local Vite,
validates the supported binding subset, packages SQL and assets, and submits an
immutable digest. `fogd status <deployment-id>` shows team-visible progress and
a bounded failure explanation using the deploy token. `fogd.json` supplies the app name and optional `buildOutput` and
`migrationsDir`; otherwise the package name supplies the app name.

From an external project, set `FOGD_HOME` to this checkout and invoke its
`packages/cli/bin/fogd.js` with Node. Teammates need only `FOGD_SERVER` and
`FOGD_DEPLOY_TOKEN`. Keep admin and bucket credentials out of teammate environments.
The CLI scrubs runtime credentials from its build child process. App builds execute
local project code, so a teammate must trust the project they build.

## Milestone 5: platform choice

[Platform design](docs/platform.md) compares four approaches and records the chosen
approval controller with fixed app fleets. Claude and Gemini reviewed it independently;
[the response](docs/reviews/platform-response.md) records accepted changes. This
avoids a Void Platform fork, a binding bridge, and a privileged Docker socket.

## Milestone 6: two apps and admin approvals

After approving both examples, `hello.localhost:8787` and `notebook.localhost:8787`
serve independently. The admin can also use the CLI:

```sh
pnpm exec fogd admin list
pnpm exec fogd admin approve <deployment-id> <sha256>
pnpm exec fogd admin reject <deployment-id> <sha256>
```

Approval pauses the app, runs migrations, publishes through celld, and verifies both
replica versions before routing resumes. Failures remain paused with a visible step
and error. Reapprove the same digest to retry, or submit a correction. Applied SQL
hashes and existing resource identities are immutable. R2 bindings can be added;
approved additions stay reserved even after activation failure or rejection. D1
and Durable Object declarations remain fixed.
A successful activation supersedes older submissions; resubmit an old artifact if
you deliberately want its code again. There is no automatic schema rollback.

Run the end-to-end acceptance script on a **fresh stack** (before manually approving
apps). It submits both examples, rejects a deployment, verifies auth and digest
checks, approves both, tests D1/R2/DO, deliberately fails a SQL migration, recovers,
and restarts the controller and workerd:

```sh
node scripts/platform-smoke.mjs
pnpm check
pnpm test
pnpm build
```

CPU, memory, V8 heap, resident-cell, request-body, upload, and pending-request limits
are enforced where the runtimes support them. These are not per-request CPU quotas.
MinIO and the controller remain single points of failure. Public/homelab deployment
still needs TLS, private peer networking, scoped storage credentials, coordinated
backups, and an operator-provisioned slot on each host.

## Milestone 7a: a complete native Void app, twice

[Guestbook](examples/guestbook/README.md) exercises React pages, typed forms and API
calls, client assets, and D1. Its qualification script rejects and approves releases,
adds a column and a page, verifies old records survive, and restarts the controller
and workerd. Run it against a running stack with an unused app slot:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.fogd/browsers" pnpm exec playwright install chromium
node scripts/fullstack-smoke.mjs
```

The fixture guide also covers normal Void local development and both target builds
in a Docker container with networking disabled. A [fresh-agent onboarding test](docs/onboarding.md)
passed from a clean checkout without author hints. Hosted execution remains
unverified; human usability feedback is optional. Existing examples can be redeployed from
source; keep volumes only when you need their data. No separate always-running test
stack is required.

## M7b: add attachments and transfer application data

The [guestbook transfer guide](examples/guestbook/TRANSFER.md) demonstrates an R2
addition to an existing app, retained D1 messages, browser upload/download, and a
bounded logical export/restore into a second app. On a fresh disposable stack:

```sh
node scripts/growth-smoke.mjs
```

This test temporarily stops public ingress for all apps, injects a restore failure,
and verifies an identical retry, post-restore writes, and restart persistence.
The profile covers this guestbook's messages and referenced attachments. General
installation backups remain M8 work. See [M7b](docs/m7b.md) and the
[roadmap](docs/roadmap.md) for the exact boundary.

## M7c: private configuration and application accounts

The [accounts fixture](examples/accounts/README.md) uses native Void email/password
signup, login, sessions, and generated auth migrations. Admins provide secrets over
stdin with `fogd admin secrets APP`; approval pins both the artifact digest and the
secret revision. App login grants no deployment permission.

To test on empty disposable volumes, first stop the current fogd stack occupying
the configured ports, then use a new Compose project name:

```sh
docker compose stop
COMPOSE_PROJECT_NAME=fogd-accounts-test pnpm exec fogd up
COMPOSE_PROJECT_NAME=fogd-accounts-test node scripts/accounts-smoke.mjs
```

The smoke deploys two isolated apps and checks browser authentication, secret
rotation, and restart recovery. Reuse of a populated project is refused. The
fixture guide covers manual deployment and failed configuration. A labeled password
adapter fills celld's missing Node scrypt primitive. Secrets stay out of submitted
artifacts, but celld's bucket stores injected values in plaintext. This remains a
trusted local qualification; installation recovery and shared hosting are M8 work.

## M8a: recover the complete installation

`fogd backup DIRECTORY` stops the local stack and captures its bucket, controller,
secret revisions, every replica disk, configuration, and exact images. `fogd restore`
verifies the snapshot and restores only to a new, stopped Docker project. Follow the
[recovery guide](docs/recovery.md) for the start command and private-storage requirements.

The [recovery drill](scripts/installation-recovery.mjs) restores accounts and notebook
after an interrupted approval and forced replica stops, then checks sessions,
D1/R2/Durable Object data, approval retry, and new writes. This qualifies local
same-version replacement; shared-operation controls remain M8b work.

## M8b1: scoped teammate access and capacity

Admins can issue a named credential for specific apps with
`fogd admin issue-token NAME APP[,APP]` and revoke it with
`fogd admin revoke-token ID`. A teammate can submit and inspect only its authorized
work; approval remains separate. See the [access guide](docs/deploy-access.md).

`node scripts/scoped-deploy-smoke.mjs` on a fresh stack qualifies two scoped CLI
users, revocation, disabled legacy access, quota refusal, and fresh-volume recovery.
Artifact and concurrent-upload limits are configurable. M8b2 adds HTTPS/shared-mode operation; remote host qualification remains M9 work.

## M8b2: HTTPS and the shared profile

`fogd tls import CERT KEY` installs an operator-provided certificate into a stopped
installation. `fogd up --shared` requires TLS and scoped deploy credentials. Follow
[shared installation](docs/shared-installation.md) for domain settings, private-CA
trust, approval, renewal, and upgrade steps. `FOGD_ENV_FILE` selects an installation
without rewriting the checkout's default configuration.

The [TLS drill](scripts/tls-smoke.mjs) checks CLI trust, native Void Secure sessions,
forwarding-header rejection, and fresh-volume recovery. The
[upgrade drill](scripts/tls-upgrade.mjs) starts from a six-volume M8a snapshot and
checks the same data and approval history after adopting HTTPS. This is a local
shared-profile qualification; remote host/storage/network failure evidence belongs
to M9.


## M9a: experimental Kubernetes deployment

The [Kubernetes guide](docs/kubernetes.md) creates an isolated local kind cluster,
loads images without publication, and deploys accounts plus notebook using the
existing HTTPS/scoped-credential approval flow. `fogd kube render` writes ordinary
manifests and separate private Secrets; it does not modify a cluster.

The live drill qualifies data and sessions across pod replacement. A worker outage
that also removed the singleton controller caused downtime; existing data returned
when the node restarted. Stopped Kubernetes recovery is available through M9b; remote
host qualification remains open. Keep this experimental profile limited to disposable data.


## M9b: stopped Kubernetes recovery

`fogd kube backup` captures the generated local kind installation after stopping all
writers. `fogd kube restore` restores it to fresh claims in a new namespace, leaving
writers stopped until ordered startup. Both commands require an explicit kubeconfig
and context. Follow the [recovery guide](docs/kubernetes-recovery.md) for commands
and the account/session, data, approval, and failure drills. Snapshots contain private
keys and application data. Remote clusters and live backups remain unsupported.

## M10a: capacity reporting

`fogd admin capacity` reports available app slots, pending limits, and retained
artifact bytes. The admin page shows the same installation totals. Follow the
[capacity guide](docs/capacity.md) to interpret ownership conflicts and limits.
`pnpm test` checks the API, CLI, page, and admission accounting. M10b adds retirement
and slot reuse; measured runtime density and capacity expansion remain later work.


## M10b: retire an app into a fresh installation

`fogd retire BUNDLE --app NAME --digest SHA --project NEW --output DIR` restores a
stopped Docker snapshot while permanently retiring one app name. Its fleet receives
fresh replica identities and an empty storage namespace for a different app. The
other apps retain their data and sessions; old data and history remain recovery material.
Follow the [retirement guide](docs/retirement.md) for commands and failure drills.
This requires maintenance downtime and a runtime that supports retirement. Kubernetes
retirement, same-name reuse, erasure, and artifact pruning are not supported.

## M10c: run three apps and measure capacity

`fogd docker render DIRECTORY --fleets 3` prepares a fresh three-fleet installation.
`fogd expand BUNDLE --fleets 3 --project NEW --output DIR` expands a stopped
snapshot onto fresh resources, preserving existing apps and adding empty capacity.
Follow the [expansion guide](docs/expansion.md) for configuration and reproduction.
Three-app approvals, isolated D1/R2/DO data, restart, full recovery, and middle-fleet
retirement/reuse are qualified locally. Kubernetes remains at two fleets.

The [measurement guide](docs/capacity-measurement.md) records paired two/three-fleet
observations with the same paced workload per existing app. These are shared-VM
measurements, not a maximum app density or production sizing recommendation.

## M11a: opt-in queued work

The [queue qualification guide](docs/queue-qualification.md) reproduces runtime
probes for publication gating, overlapping releases, delayed effects, exhausted
retries, stopped recovery, and a [native Void imports app](examples/imports/README.md)
with D1 migration overlap and recovery after killed consumers exhaust delivery.
The [activation coordinator](docs/queue-activation.md) integrates bootstrap, pause,
migrations, publication, and restart recovery, with controller process-kill tests.
A built-controller Docker probe also covers real bootstrap, migration, and lost-resume
recovery. [Admin delivery controls](docs/delivery-controls.md) provide recorded status,
refresh, pause, and exact-approval resume through the CLI and browser.
[Replacement approvals](docs/queue-replacement.md) recover from faulty unapplied
migrations while preserving the hold and applied hashes. Queue admission has a
[supported Docker opt-in](docs/queue-admission.md)
and remains off by default. See the [design and review response](docs/reviews/m11a-response.md).

Docker queue recovery has a [private-artifact qualification](docs/queue-recovery.md)
with persisted pause, retention checks, and explicit acknowledgment before resume.


Queued Docker retirement has [local qualification](docs/retirement.md#queued-app-retirement):
an explicit stop-work flag retains old queue history while a fresh fleet runs a
replacement app. Surviving apps retain recovery acknowledgment and resume controls.
The [completion drill](docs/evidence/m11a-queue-retirement-complete.json) compares retained
objects with the source and restores an installation containing only retired queues.
The [normal CLI checkpoint](docs/queue-admission.md) now covers scoped upload,
pending-only backup/restore, exact approval, derived-name dispatch, and application
retry. The same guide includes duplicate pending-work recovery and direct gateway
browser checks. Canonical CLI artifacts also pass additive update with handler
overlap and retirement/replacement checks. The [acceptance audit](docs/m11a-acceptance.md) closes the bounded Docker slice.
Default admission stays off by policy because queues constrain expansion/recovery.


## M11b: qualified local live sessions

The [reviewed plan](docs/m11b.md) covers durable operations, browser reconciliation,
preserved WebSockets across updates, and separate SSE acceptance. Its minimal native
Void room already passes a workerd WebSocket roundtrip without a shim. The guide
includes fresh-fixture reproduction. The [checklist server](examples/checklist/README.md)
now has a UI, persistent pending edits, and tested lost-ack reconciliation through
workerd. Its [explicit Void client patch](docs/patches/void-websocket-send.md) prevents
pre-snapshot buffering. [Owner and gateway process-loss checks](docs/evidence/m11b-process-failure.json)
preserve acknowledged edits. [Idle eviction](docs/evidence/m11b-idle.json) preserves
the native socket and room behavior. [Non-owning ingress loss](docs/evidence/m11b-ingress.json)
also preserves the board and reconnects. An [explicit celld patch](docs/patches/celld-preaccept-attachment.md)
qualifies preserved-socket updates, including after idle eviction; upstream 0.6.2
still fails that gate. [Route-pause checks](docs/evidence/m11b-route-pause.json) confirm
new connections are refused during approval while an established socket commits
an edit. An [experimental SSE observer](examples/checklist/README.md#experimental-sse-observer)
passes hints, reconnect snapshots and deployment replacement with an explicit
[Void registration patch](docs/patches/void-live-registration.md). [Publication-stall and cross-app isolation checks](docs/evidence/m11b-sse-failure.json)
also pass. [Healthy ownership movement](docs/evidence/m11b-move.json) preserves
boards and receipts through native reconnects. [Stopped board/receipt recovery](docs/evidence/m11b-restore.json)
also passes, including explicit acceptance after an older restore. The [acceptance audit](docs/m11b-acceptance.md) qualifies this bounded Docker
slice with pinned Void patches and the opt-in celld candidate.

The [approval probe](scripts/live-approval.mjs) checks two fresh apps before and
after exact approval. First prepare the two-app [SSE fixture](examples/checklist/README.md#experimental-sse-observer)
with the candidate runtime; the source must contain `live-probe` and `checklist`.

```sh
FOGD_ENV_FILE="$PWD/.fogd/sse-fixture/probe.env" \
  node scripts/live-approval.mjs .fogd/live-approval
```

It temporarily stops the source stack, uses a fresh stack on the same ports, and
restores the source after cleanup. It retains all volumes. Use a new output
directory. Scheduled background work is the [next discovery slice](docs/m11c-discovery.md).

## M11c in progress: scheduled work

The [native cron probe](docs/cron-qualification.md) records timer invocations on
two celld nodes without HTTP triggering. The [proposed contract](docs/m11c.md)
requires migration-safe approval, dispatch controls, retry semantics and recovery. A
patched celld build now preserves the original scheduled time through a single-node
owner loss; see the [evidence](docs/evidence/m11c-cron-retry-positive.json). This is
not a supported deployment mode: ordinary `fogd deploy` still rejects cron
declarations, and native tests, timeout behavior, pause controls and recovery remain open.
