# Implementation notes

These notes preserve experiment results and failed approaches. Reproduction steps
for the current implementation live in the README.

This log records experiments, source revisions, verification, and unresolved gaps.

## Initial environment

The starting repository contains the published `@fogd/cli` stub and a clean main
branch with an existing unpushed repository-URL commit. Docker Desktop provides
Linux arm64 containers. Dependencies and upstream checkouts stay inside this repo.
No Cloudflare credentials, Cloudflare API calls, global installs, or npm publishing
are part of this work.

## Milestone order

1. Inspect pinned upstream source, write compatibility and architecture, peer review.
2. Generate and serve a Void starter with D1.
3. Exercise R2, Durable Objects, migrations, and node/runtime recovery.
4. Package local startup and deployment in the CLI.
5. Compare platform options and peer review the choice.
6. Implement and verify two apps through admin approval; write the final report.

## Repository creation

The initial push and `gh repo view fogd-dev/fogd` returned repository not found.
The user confirmed the organization was new and suggested creating the repo.
Created the public `fogd-dev/fogd` repository and pushed the preserved main history.

## Runtime artifacts

Audited upstream revisions are recorded in compat.md. The published celld 0.6.2
multi-architecture image pulled successfully on Docker arm64. The architecture
proposal keeps the full app in celld to avoid inventing binding protocols.

## Milestone 2 verification

- `npx --no-install void init`: D1 demo, deployment setup skipped, SQL generated.
- Local Vite build succeeded; initial multi-module output failed in celld because
  its no-bundle path collects only the entry JavaScript. ADR 004 records the fix.
- MinIO source Docker build succeeded. celld diagnose passed conditional create,
  reject-create, update, reject-stale, and signed probes of both live peers.
- Both replicas reported adoption of version `188014d5c6cdbcaf` through `/reload`.
- `celld d1 migrations apply hello-db /artifact` applied the generated SQL.
- `GET /api/posts` through workerd with the hello hostname returned `[]` (HTTP 200).
- The slim Node runtime needed system CA certificates for workerd startup. They
  are copied from celld's Debian image, without modifying the host.
- Deployment now waits for bucket initialization; the first direct deploy raced
  bucket creation and received NoSuchBucket before that dependency was added.

## Milestone 3 recovery investigation

The notebook uses a Drizzle D1 table, two SQL migrations, R2 object bodies, and a
SQLite Durable Object ledger whose unique operation IDs make repeated PUTs
idempotent. The writes across the three bindings are not one transaction.

The first recovery run exposed an upstream identity boundary: after A restarted
with a random ID, killing B blocked B's log recovery on the old A witness. The
saved log is not evidence of successful failover. Restoring both original IDs
against their original volumes recovered the existing entries without deleting
bucket data. ADR 005 records the supported configuration used for the repeat test.

Node's fetch ignored the Host override in the first test harness, so virtual-host
checks now use node:http. The runtime was responding correctly to curl; that
particular timeout was a harness bug, separate from the log-witness problem.

The repeated recovery run with retained replica identities passed both forced
container stops, both rejoins, and a workerd restart. It also rejected the public
Void migration route with HTTP 404. The acknowledged notebook state included the
R2 body and a Durable Object count of 3; a duplicate PUT did not increment it.

## Milestone 4 verification

`pnpm exec fogd deploy` ran successfully from both `examples/notebook` and
`examples/hello`. The CLI built and staged each app, published through celld,
verified both replica versions, and skipped already-applied SQL. The hello
version was `188014d5c6cdbcaf`; notebook was `1c2f1729170db2fa`. Both sample apps'
builds and the artifact validation tests pass. The direct mode is deliberately
single-app; milestone 6 replaces the public default with the approval API.

## Platform implementation and live acceptance

Claude and Gemini completed platform design reviews using valid CLI commands with
15-minute limits and streaming logs. Both chose the custom approval gate. Their
high-priority ownership, canonicalization, migration-reconciliation, and exact-digest
findings were incorporated; the proposal and response remain in `docs/reviews/`.

The platform smoke test passed against real Docker services: two CLI-built Void
artifacts, no route before approval, rejection, wrong-digest rejection, forbidden
submitter approval, malformed artifact rejection, both app hosts, D1/R2/DO writes,
intentional SQL syntax failure, corrected submission, and controller/workerd restart.
The invalid SQL was never recorded as applied; resubmitting the original artifact
restored the notebook without changing the checked-in sample migration history.

Eleven unit tests passed, including partial migration failure and restart/ownership
failure injection. Both sample production builds passed. No Cloudflare APIs, npm
publication, host-global installation, or Docker socket mounts were used.

## Fresh-checkout verification

Commit `3b00571` was checked out into a separate detached worktree with no build
outputs, `.env`, node_modules, or deployment state. `pnpm install --frozen-lockfile`
and `fogd up` succeeded with Compose project `fogd-clean`, fresh bucket/controller/
replica volumes, and alternate ports 8877/8878. Docker reused downloaded/base build
layers, but no prior deployment state. `scripts/platform-smoke.mjs` passed in full,
including both CLI builds and approvals, deliberately failed SQL, recovery, and
controller/workerd restart. Runtime versions matched the original checkout:
hello `188014d5c6cdbcaf`, notebook `1c2f1729170db2fa`.

The original platform fleet also passed `scripts/recovery.mjs`: both replicas were
force-stopped in turn, the survivor served acknowledged D1/R2/DO data, a new write
was made after the first rejoin, both replicas rejoined, and workerd restarted.
No missing-witness recovery errors appeared. The script defaults now target
notebook's second platform slot and allow replica-service overrides.

## Final verification after implementation review

The clean-checkout recovery test also passed with both replica failures, a write
between failures, and workerd restart. After Claude's implementation review, commit
`cd55741` passed the full approval smoke again with another fresh set of Docker
volumes (`fogd-final`, ports 8977/8978). Seventeen unit tests and both production
builds passed. The added regressions cover shrinking migration ledgers, duplicate
bucket ownership markers, concurrent/stale approvals, stored-artifact tampering,
encoded internal paths, and avoiding replay of ambiguous writes.

Both temporary acceptance stacks were stopped after verification; their volumes
were preserved. The primary `fogd` stack retains both approved sample applications.
The feature overview requested during implementation is in `docs/features.md`, with
runtime/API evidence separated from the capabilities fogd actually exposes.

## M7a local qualification, 2026-10-16

The native React guestbook uses the pinned Void starter generator, D1 schema and
Drizzle migration metadata. Its first build exposed inherited client inputs in the
worker environment; selecting Void's virtual worker entry fixed the single-module
build. The first activation exposed celld's rejection of `.assetsignore`; staging
with Void-style exclusion semantics fixed publication. Neither required an upstream
source patch. ADR 007 records the adapter boundary.

The browser smoke then exposed test-harness assumptions: React inserts comments
between text nodes in SSR HTML, hydration can finish after the form becomes visible,
and Playwright's browser path must be configured before importing its registry.
The assertions now check the route heading and API data, establish client readiness
with a read-only action, and initialize Playwright in one helper. The full smoke
passed from fresh Docker volumes through two releases and a controller/gateway
restart. The same browser helper passed against normal Void development with a
separate local database. The generated second release remains an ignored temporary
copy; the checked-in example always starts at release one.

The original example stack was stopped with its volumes retained. The disposable
`fogd-m7` project used the normal local ports and fresh test volumes; preserving two
running copies is not a requirement. Recreate examples from source when needed.

The verification image excludes host-generated Void/Wrangler state. With dependencies
already installed, a `--network none` run passed guestbook type-checking, ordinary
Vite build, and fogd build. No hosted deployment was attempted. These are agent-run
reproductions, not evidence that a second developer completed onboarding unaided.

M7a review fixes restrict uploaded worker files to the runtime entry and Wasm;
source maps and preview secret files are excluded. Asset secret exclusions cannot
be negated. The offline comparison observed 14 server JavaScript files in ordinary
Void output and one in fogd output; both retained `nodejs_als`, D1 `DB`, and the
same client asset configuration. These counts describe this fixture and pinned
build, not a size or determinism guarantee. The verifier now also stages the fogd
artifact while offline. Full findings and responses are in `reviews/m7-response.md`.

## M7b qualification, 2026-10-16

The first live growth run retained the guestbook's messages and passed attachment
upload/download, then failed with 404 at the private export endpoint. Gemini's
source review identified Void's exclusion of underscore-prefixed route directories.
Moving the endpoints into native middleware resolved it. Middleware returns HTTP
responses explicitly; plain objects are only converted by `defineHandler`.

The next run passed the logical roundtrip, invalid-checksum rejection, injected SQL
failure after R2 writes, identical retry, and post-restore writes. The original
platform smoke also passed after resource validation changed. The transfer command
was exercised twice with the same snapshot file. Final qualification includes a
101-row export refusal with a bounded-profile error and byte-for-byte attachment
reads after restart. Tests used disposable `fogd-m7b` volumes; prior installations
were stopped. No other Docker project's state was changed.

Gemini's specification review returned findings but reported an interrupted stream.
Its later implementation review completed successfully, as did both Claude reviews.
Original review outputs and accepted/deferred findings are under `docs/reviews/`.
Offline verification covers both base and grown apps: type-check, normal Void build,
fogd build, and staging with `--network none`. Hosted execution remains untested.

### M9a local qualification capacity

The first kind creation hit Docker's exhausted default network pool. Removed only
stopped fogd TLS test containers/networks, retaining their volumes and snapshots;
the isolated kind retry succeeded. A later fresh-run verification exhausted Docker
disk while importing the runtime into a third kind cluster. It exited with ENOSPC.
Deleted the earlier disposable m9a test cluster and the failed empty m9final cluster,
keeping logs/evidence and the successful m9verify cluster. Those discarded clusters
held only generated test data. No global Docker storage/network settings, unrelated
workloads, or Compose recovery snapshots were modified. Retry uses a fresh name.


## M9b qualification interruptions

Two reviewed negative-drill attempts timed out while the Mac repeatedly slept on
battery. Claude's read-only diagnosis correlated host power logs with celld lease
self-fencing on both workers and control-plane timeouts after wake. The source
remained partly stopped; no force deletion or completion manifest was used to hide
that failure. A temporary caffeinate process holds the machine awake during the
repeat; no persistent power settings changed. The first final code-review request
also timed out without a verdict and was retried rather than counted as approval.

Docker storage reached 94% during successive disposable kind fixtures. Removing
only the older fogd verification cluster freed space to 81% used. Its evidence was
retained, as were the current recovery claims and earlier backup artifacts.
Unrelated containers were not modified.

The awake negative rerun reached its last isolation check but lacked
NODE_EXTRA_CA_CERTS in the invocation, so HTTPS requests failed trust validation.
The next complete rerun supplied the documented CA, passed every negative check and
namespace isolation, and left all source pods Ready. This was a test invocation
error, not a change to transport validation. No certificate checking was bypassed.

## M10b fixture corrections

The first live retirement test passed a scoped deploy token into the operator's
Compose environment. Backup correctly refused configuration drift before stopping
anything. The drill now keeps operator configuration separate from teammate deploy
credentials.

Docker exhausted its predefined network address pools after many retained test
projects. Removed only stopped fogd M7/M8 fixture containers and their Compose
networks, retaining volumes and backups. No daemon configuration or unrelated
containers changed.

A second target restored successfully and served accounts, but the browser check
started after controller readiness without waiting for the app. Its first navigation
could remain on a temporary unavailable page while retrying only a button click.
The drill now checks the original session before backup and waits for the restored
app's HTTP 200 before opening the session page. A fresh run supplies the final
qualification; the failed attempt is not counted as a passing session check.

The third retirement run preserved native sessions and approved the replacement,
but its reused certificate lacked replacement.localhost. TLS correctly rejected the
request. The fixture now checks required certificate names before mutations, and a
new certificate signed by the existing local test CA covers all three app names.
Certificate validation remains enabled. Old stopped M10 attempts had containers and
networks removed to keep fixture address pools available; their volumes and snapshots
remain retained.

The final fogd-m10b4 run passed complete retirement with the corrected certificate
and readiness checks. The subsequent negative drill also passed interruption,
fresh-target retry, old-runtime refusal, and ordinary restore regression. Its temporary
Docker wrapper existed only under .fogd and only the test child used that PATH.
No global executable or daemon setting was modified.

## M10c expansion qualification environment notes (2026-10-19)

The first expansion drill completed source backup, fresh expansion, all-source-volume
tar comparison, and existing app/authority checks. Third-app submission then failed
because NODE_EXTRA_CA_CERTS was relative while the CLI child runs inside the example
directory. The drill now normalizes that path; the continuation used an absolute CA
path and resumed from verified completed expansion receipts, without reusing a partial
restore or pretending the first invocation passed end to end.

The third app then deployed and stored isolated data. The initial fourth-app capacity
probe changed the app name on the third app's artifact, which correctly failed
canonical configuration validation. It now builds a real fourth-app artifact and
asserts the specific capacity error. A subsequent continuation passed capacity refusal
and gateway/replica restart. These were fixture errors, not successful capacity tests.

Removed only stopped containers and networks for old M10b interrupted/retry/ordinary
fixtures and the completed M10c ordinary restore fixture to free Docker network pools.
All their volumes, output configurations, and snapshots remain. Unrelated buzz services
and the kind cluster were left untouched. Logs are in `.fogd/m10c-network-cleanup.log`
and `.fogd/m10c-recovery-network-cleanup.log`.

### M10c fresh rendering and paired observations

Paired two/three-fleet paced reads passed with zero HTTP errors. The original
retired three-fleet installation was restarted and all three routes checked.
Fresh rendering then hit Docker's exhausted default address pool before TLS import.
Removed only stopped `fogd-m10c-expand-negative-interrupted` and
`fogd-m10c-expand-negative-retry` containers/networks, retaining their volumes and
evidence; retry succeeded. Fresh scoped alpha/beta/gamma deployment, approval,
migrations, and isolated D1/R2/DO state passed. No global prune or system network
change was used. Detailed logs remain in the private `.fogd/` evidence directory.

The final Claude review requested a complete rerun of the checked-in expansion
drill and precise refusal matching. Both now pass in
`.fogd/m10c-expansion-full-rerun.log`, targeting `fogd-m10c-full-expanded`.
The pre-expansion token successfully submitted the third app after restoration.
Removed only the stopped fresh-three-app fixture containers/networks for address
space before that rerun; its volumes remain retained. The source archive check
compares archived entries, not the absence of extra files. Updated the PASS wording
accordingly. The paired measurements intentionally restarted disposable source
copies sequentially; those copies are no longer pristine snapshot contents.

### M11a queue lifecycle and recovery evidence

The initial held-handler probe passed on the second fleet of `fogd-m11a-probe`.
After Claude review, both fleets of the fresh `fogd-m11a-qualified` fixture passed
the strengthened harness: generation ownership, concurrent v1/v2 completion,
empty/paused `waitUntil` effects, background work beyond the response budget,
exhaustion, and timeout without a late R2 completion marker. The recovery repeat
passed on `fogd-m11a-qualified-restored`, including an observed pause after the
interrupted message's captured lease expiry. That target remains running with
both queues paused; the qualified source remains stopped. Earlier fixture volumes
and snapshots are retained. Only verified stopped fixture containers/networks were
removed to free Docker address pools; unrelated workloads were untouched.

Private logs: `.fogd/m11a-qualified-slot1.log`, `.fogd/m11a-qualified-slot2.log`,
and `.fogd/m11a-qualified-recovery.log`. Public evidence omits credentials, full
Compose configurations, queue payload inspection, and recovery archives. These
are runtime probes, not admitted fogd apps. Follow the reviewed controller/native
Void gates before changing the supported configuration allowlist.


## M11a controller activation qualification (2026-10-19)

Stopped `fogd-m11a-native` with Compose down, preserving its volumes and private
fixture config in `.fogd/m11a-native-fixture`. This freed its networks and ports
without touching unrelated stacks. Built `fogd-m11a-activation` on ports 8891/8892,
with frozen runtime images, two fleets, and 20-second handler budgets.

Private built-controller probes passed on both fleets. Slot 2 used the reviewed
recovery/restore guards. Evidence is in `.fogd/m11a-controller-live` and
`.fogd/m11a-controller-live-final`; selected output is committed in
`docs/evidence/m11a-activation.json`. Both queues were left paused. Controller probe
state lives in separate qualification directories inside the controller data volume.
These are not deployments tracked by the main HTTP controller. Its restart after
slot 1's probe therefore quarantined slot 1 as expected; the private coordinator
state remains separate. Do not treat this fixture as public approval-flow evidence.

Claude's two reviews and their response are committed under `docs/reviews/`.
Queue admission stays closed. The next slice is authenticated delivery controls and
corrected-artifact hold transfer, followed by stopped recovery/retention and full
approval/isolation acceptance. The process-kill fixtures prove controller recovery
using persisted fake runtime effects; the live Docker probe uses a lost response
and object reconstruction rather than killing the controller container.


The first live probe reapproved identical bytes, which retained the runtime version.
Strengthened the probe to change a harmless configuration variable and require a
distinct version. Parked `fogd-m11a-activation`, again retaining volumes, and built
`fogd-m11a-controller-v2` from final source on the same ports. Slot 1 passed the full
probe with distinct versions; `.fogd/m11a-controller-versioned` and the selected
committed evidence record this run. Its queue is paused and slot 2 is unused.
The fixture env/config is `.fogd/m11a-controller-v2-fixture/probe.env`.


## M11a admin delivery controls (2026-10-19)

Rebuilt the controller image in `fogd-m11a-controller-v2` and pointed its data root
at the private qualification directory recorded by the preceding activation probe.
The main HTTP controller now owns that seeded app's metadata. The previous Compose
config is retained as `.fogd/m11a-controller-v2-fixture/compose-before-admin.json`.
This is test-fixture wiring, not an app adoption workflow or public admission path.

Admin HTTP and browser probes passed with the reviewed image. Evidence is in
`.fogd/m11a-admin-live-final` and `.fogd/m11a-admin-browser-reviewed`; selected JSON
is committed. Delivery is paused. The first browser attempt used Playwright's global
cache default and found no executable; reusing the repo's existing browser helper
selected `.fogd/browsers` and passed without a global install.

Claude identified weak race-test timing and CLI resume selecting the active ID
implicitly. The test now waits for entry into the controller lock; CLI resume takes
both ID and digest. Runtime errors return bounded 502 responses, and private version
hashes are excluded from delivery and general admin views. Queue admission stays closed.


## M11a corrected-artifact recovery (2026-10-19)

The first live repair probe passed on unused slot 2 of `fogd-m11a-controller-v2`.
After review follow-ups, parked that stack without deleting volumes and built
`fogd-m11a-repair-final` from final source on ports 8891/8892. Its private two-fleet
config is `.fogd/m11a-repair-final-fixture/probe.env`. Slot 1 passed the final probe;
slot 2 remains unused. Evidence is `.fogd/m11a-repair-live-final`, with selected JSON
committed. The repaired app is `imports-repair`, its queue is paused, and its private
controller directory is recorded in the evidence. The main HTTP controller does not
own those privately staged records; a restart can quarantine that fleet as expected.

The live probe's third migration inserts a row and then uses invalid SQL. The row
rolls back, while the first two files remain applied. A candidate changing an applied
file is rejected. The corrected third file then activates through the actual HTTP
approval handler, leaving one `corrected` audit row. Source inspection confirmed the
per-file transaction in pinned celld `storage.rs:3108` before the runtime probe.

The separate browser proof uses the real HTTP controller with a runtime stand-in.
Its first attempt tried to read a response body after the page reloaded, which CDP
no longer retained. The probe now captures the posted request and checks controller
state plus the rendered active card; it passes without changing product behavior.
Evidence is `.fogd/m11a-repair-browser-final`.

### M11a queued installation recovery qualification

The first full Docker restore retained pending work and persisted pause, then the
probe used Node fetch with a Host override and hit an unknown-app route. The probe
now uses the existing HTTP virtual-host helper. A later fresh target hit Docker's
exhausted address pools; stopped disposable M11 containers/networks were removed
with Compose down, retaining their volumes and all snapshots. No global prune or
system network configuration change was used.

The simultaneous-start drill exposed the expected window where a controller records
pause intent before replicas are ready. Recovery now retries that pending pause,
records a new review, and requires explicit acknowledgment of it. The final
qualification uses the documented all-services startup command. Source bundles,
intermediate failed targets, and private records remain under `.fogd` for inspection.


### Queued retirement fixture address exhaustion

The first fresh retirement target exhausted Docker's predefined address pools before
container creation. Retained the failed private output and complete source snapshot.
Removed the unused stopped `fogd-m11a-recovery-qualified` containers/networks with
Compose down, preserving its volumes. A fresh `fogd-m11a-retirement-retry` target
then restored successfully. The old source remains stopped. Unrelated containers
and system Docker configuration were not changed.


### Queued retirement completion harness readiness

The first completion attempt submitted immediately after controller readiness and
received 503 while replicas restarted. The second passed source-prefix comparison
but attempted survivor acknowledgment before its approved generation was ready.
Added distinct HTTP readiness and generation checks. Resumed from recorded progress
only after comparing the retained source-prefix hashes again. The resumed run retired
the last app and completed zero-live backup/restore. Source snapshots and volumes
remain retained; the fixture releases its own stopped containers/networks between
fresh targets to avoid exhausting Docker's address pool.


The replacement fingerprint algorithm did not change between the initial and resumed
completion runs; only readiness/resume handling changed. It subsequently moved into
prefix-fingerprints.mjs unchanged. Final read-only inspection compared the first
retired app against its original stopped source and checked all target containers.
Its first attempt incorrectly passed already-inspected container objects back to
Docker inspect; the corrected attempt passed. This was a harness error after hashing,
not a recovery or storage failure.


### Normal queue upload qualification

The first public-path harness assumed a never-deployed fleet had no objects at all.
celld initialized wake-format metadata while idle. Changed the assertion to require
no app ownership and no deploy objects, then resumed the single existing pending
request with its scoped credential identity. Pending-only backup/restore and exact
approval succeeded; the derived Void queue processed success, retry, terminal failure,
and explicit retry without duplicate result rows. The fixture remains opted in and
operator-paused; repository defaults remain off.


The public failed-claim drill deliberately stopped only the disposable bucket service
before approval, restored it in a finally block, and rejected the verified unclaimed
reservation through the normal admin API. Subsequent backup succeeded. Empty second-
fleet replicas exited 143 during shutdown, without OOM; manifest exits preserve this
crash-recovery requirement. The source remains stopped with a complete snapshot for
the next restore qualification.


The current-image history drill combines all inert same-name transitions: a prior
released claim, a rejected unapproved queue upload, and a pending queue upload later
superseded by a non-queue approval. It also stops one replica, kills the controller
while a new queued approval holds delivery, restarts with admission disabled, and
retries the pinned approval. All pass and the final backup is complete. Independent
Docker inspection confirms admission was 0 in the actual controller container.


## Native Void attachment loss across deployment replacement

The M11b update experiment in `.fogd/m11b-update-linked` built a copied checklist
with only its release marker changed to v2 and deployed through scoped upload and
exact approval. Its initial copy needed a node_modules link for the React plugin;
that build issue was corrected before the runtime experiment.

After approval the browser still had its original socket. The next saved v1 edit
hit `Missing checklist room attachment`, closed with 1011 and recovered after
reconnect. `.fogd/m11b-update-runtime.log` records the failing handler. Ordinary idle
eviction already passes the attachment guard, so the current discriminator is
handler replacement. The pinned source is celld v0.6.2 at 90b4301. A focused Claude
review is tracing the reload path. Do not remove the guard or count reconnection as
passing the preserved-socket gate.


The source review identifies an attach-before-accept mismatch: Void writes its
stored connection before `acceptWebSocket`, while celld's attachment op only writes
an existing registry entry. Idle eviction may retain the JS socket and its cached
attachment; a generation swap does not. A temporary post-accept rewrite is the next
discriminating experiment. If it resolves the failure, prefer a labelled celld
upstream patch retaining the encoded bytes until acceptance over an app workaround.
