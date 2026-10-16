# fogd implementation report

fogd is a local, self-hosted deployment platform for the supported subset of Void
apps. workerd handles hostname routing. Each complete app and its stateful bindings
run in a separate two-replica celld fleet. A teammate submits an immutable build;
an admin reviews and approves its exact digest. No Cloudflare account or API is used.

## What works

| Milestone | Result and reproduction |
| --- | --- |
| 1. Compatibility and architecture | Source-pinned [matrix](compat.md), [architecture](architecture.md), and independent reviews; see README milestone 1 |
| 2. Hello world | Actual `void init` D1 starter builds through Vite and serves `/api/posts` through workerd/celld/MinIO; see README quickstart |
| 3. Realistic app | Notebook uses D1, R2, a SQL-backed Durable Object, and two SQL migrations; recovery script checks both replica failures and workerd restart |
| 4. CLI | `fogd up` creates private local credentials and starts Docker; `fogd deploy` builds in a Void app and submits its artifact |
| 5. Platform design | Claude and Gemini independently reviewed the selected custom approval gate; original proposals and responses are preserved in `reviews/` |
| 6. Platform | Two apps, exact subdomain routing, Basic-authenticated admin UI/CLI, immutable-digest approval, rejection, failure/retry, and runtime resource limits |
| 7a. Native full-stack qualification | Guestbook pages, form actions, typed client/API, split client assets, two approved releases and additive SQL; see the [fixture guide](../examples/guestbook/README.md) |
| 7b. Application growth and logical transfer | R2 additions preserve D1 records; browser attachments and bounded restore with failure/retry; see the [transfer guide](../examples/guestbook/TRANSFER.md) |
| 7c. Private configuration and native auth | Revision-pinned admin secret input, native Void account/session flow, two-app isolation, rotation, and restart checks; see the [accounts guide](../examples/accounts/README.md) |
| 8a. Stopped installation recovery | Fresh-volume restore with exact images, full replica logs, private configuration, interrupted approval retry, and continued writes; see the [recovery guide](recovery.md) |

The live Docker acceptance test passed for hello and notebook side by side. It
verified no route before approval, rejection, submitter/admin separation, wrong-digest
rejection, artifact-path rejection, D1/R2/DO writes, isolated SQL activation failure,
corrected resubmission, and controller/workerd restart persistence. Unit tests cover
interrupted activation, migration reconciliation, controller metadata loss, auth,
artifact validation, ownership conflicts, and ingress behavior. The sample production builds pass. The final implementation also passed the approval smoke on fresh
Docker volumes after review fixes.

The initial direct runtime recovery test passed with both replicas force-stopped in
turn, a write between rejoining/failing replicas, and a workerd restart. The same recovery check passed on the platform fleet. A separate clean checkout
with fresh Docker volumes passed installation, startup, both CLI builds, and the
complete approval smoke test; details are recorded in [notes](notes.md).
Run `node scripts/platform-smoke.mjs` on a fresh stack and `node scripts/recovery.mjs`
after approving notebook second. The README contains all six reproduction sections.

The M7a browser smoke passed on fresh local Docker volumes: rejection before first
activation, approved pages and CSS, form writes/reload, typed API reads, a generated
additive migration, existing rows with the new default, a new history page, and
controller/workerd restart. The ordinary Void development server passed the same
browser form/API check with its separate local database. Type-checking includes
negative client contracts. Both ordinary and fogd builds passed in a Docker run
with `--network none`; hosted execution remains unverified.

A fresh smaller agent independently completed the documented automated workflow
from a clean checkout with new credentials and volumes, without author hints.
The [onboarding record](onboarding.md) closes the revised M7a reproducibility gate.
Human usability and manual admin-UI onboarding remain unverified and optional.

M7b's local growth smoke passed with an approved R2 addition, retained D1 messages,
browser upload/download, and logical transfer to a second app. A SQL trigger forced
restore to fail after object writes; no message/attachment rows committed, and an
identical retry completed without duplicates. Corrupt/different snapshots were
refused, a new message was saved after restore, and controller/workerd restart
preserved the records. Base and attachment fixtures also built with networking
disabled. See the [M7b review response](reviews/m7b-response.md).

M7c qualifies the accounts fixture with two isolated apps, CLI secret input and
approval, browser signup/login/logout, private API checks, ordinary updates, rotation,
and controller/workerd/celld restart persistence. Invalid environment values leave
routing paused; failed retries retain their pinned revision. Void's native auth uses
an explicit scrypt adapter because celld lacks that Node primitive. Secret revisions
stay outside artifacts, but injected values are plaintext in celld's bucket. See the
[review amendments](reviews/m7c-response.md) for the scope and upstream gap.

## Runtime boundary and corrections to the initial assumptions

Splitting a worker's native bindings across workerd and celld would need an API
bridge with significant semantic gaps. Keep complete apps in celld and use native
HTTP external services in workerd. Both runtimes have dynamic worker loading, but
neither standalone runtime supplies Cloudflare Workers-for-Platforms dispatch
namespaces. celld explicitly rejects AI and dispatch bindings in its config parser.

celld has one live deployed entrypoint per fleet prefix, so two apps need two fleets.
Its single-entry `no_bundle` collector does not upload Vite JavaScript chunks: fogd
disables worker code splitting during the build. No upstream runtime patch was needed.

Bucket-backed state does not mean replica disks and names are disposable. A recovery
experiment failed when a restarted replica received a random new identity; witness
requests for the old log were rejected. Retaining the original node IDs, peer
addresses, and log volumes recovered the acknowledged data. Stable IDs plus a
conservative lease-expiry delay are now the default. See ADR 005 and its source review.

## Limits and open gaps

- This is for trusted, reviewed apps. celld's internal operator interfaces and shared
  local bucket credentials do not form a hostile tenant sandbox. Fleet networks help
  separate apps, but storage credentials must be scoped before crossing trust boundaries.
- Two static app slots are provisioned. There is no scheduler, autoscaling, automatic
  slot recycling, certificate/DNS provisioning, or public production deployment.
- MinIO and the controller are single points of failure. Routing returns 503 when
  the controller is unavailable. Preserve coordinated controller, bucket, and replica
  backups. Lost controller metadata quarantines occupied slots; restore it explicitly.
- Only the adapter's validated configuration subset is accepted: string variables,
  one D1 database per app, R2, local SQL-backed Durable Objects, and static assets.
  Existing resource identities remain fixed. R2 additions are supported and stay
  reserved after approved failures; D1/DO additions and resource retirement remain
  unsupported.
  Unsupported AI, WfP, Hyperdrive, queues/workflows, cron, cross-app service bindings,
  automatic runtime auth-migration control paths, and other unsupported nonempty
  declarations fail rather than disappear. Native auth uses checked-in generated SQL.
- R2 multipart handles are process-local upstream. Examples exercise ordinary puts
  and gets. Native React pages and client assets are tested; larger asset collections,
  streaming, WebSockets, and remote two-host
  deployment have not been qualified by these tests.
- Approval pauses routing. Schema changes and deployment are not one transaction;
  in-flight requests and existing Durable Object alarms are not quiesced. Use
  backward-compatible SQL. A route pause alone does not make a backup consistent;
  there is no automatic rollback. Applied migration hashes are immutable. A failed,
  unapplied migration may be corrected after authoritative ledger reconciliation.
- Basic auth is appropriate for this loopback HTTP demo. Public use requires TLS,
  scoped teammate credentials, audit retention, and stronger identity management.
- CPU/memory/V8/request-size limits are coarse. There is no per-request CPU billing,
  hostile-code isolation, total artifact-storage quota, or automatic artifact pruning.
- The expanded CLI has not been published to npm. Use the workspace CLI or invoke its script
  with `FOGD_HOME` pointing at this checkout. Future package names use `@fogd/`.

## Decisions in one place

1. Keep complete apps and native stateful bindings in celld; use workerd for ingress.
2. Give each app a separate fleet/prefix and two persistent replicas.
3. Build pinned MinIO source in Docker because upstream images were unavailable.
4. Disable worker code splitting to match celld's single-entry artifact collector.
5. Keep node identity, advertised address, and log volume together across restarts.
6. Use a small approval controller with conditional bucket ownership fences and
   static workerd backend bindings. Pause before activation, verify both versions,
   reconcile migration ledgers, and require explicit retry after interruption.
7. Select the native Void worker entry and materialize asset ignore rules before
   celld deployment, while retaining normal client splitting.
8. Expose status through the existing team credential with fixed failure messages;
   individual identities and raw diagnostics remain separate concerns.
9. Upload only runtime worker modules and enforce secret-file asset exclusions;
   omit local preview secrets and worker source maps.
10. Use fresh-agent onboarding as the reproducibility gate without waiting for humans.
11. Reserve approved additive R2 identities, even after failure; show changes against
    the active release.
12. Qualify one bounded logical guestbook transfer during an explicit maintenance
    window, with digest-based retries and atomic SQL completion.

The [feature table](features.md) compares the implemented platform with its runtimes,
Void, and hosted Cloudflare. Read [decisions.md](decisions.md) for context, alternatives, and reasons, and
[platform.md](platform.md) for the deployment state machine and operational scope.

The [M7a review response](reviews/m7-response.md) records Claude and Gemini findings,
including preview-secret packaging and browser-test fixes.

M7c adds ADR 013 (private revision pinning) and ADR 014 (the explicit password
primitive adapter). The next roadmap milestone is M8: recoverable installation,
starting with a stopped backup/restore qualification before shared hosting.

## M7c verification record

The final unit suite passes 31 tests, including pre-claim secret pinning across
restart and canonical metadata rejection. `pnpm build` and syntax checks pass.
The quality gate passes without relaxed thresholds. The original platform smoke
also passes on fresh volumes, covering hello/notebook approval, failed SQL recovery,
D1/R2/DO behavior, and controller/workerd restart.

`docker build -f docker/verify.Dockerfile -t fogd-verify:m7c .` followed by
`docker run --rm --network none fogd-verify:m7c` passes ordinary and fogd builds
for guestbook, attachments, and accounts. It verifies the accounts secret declaration
survives staging. This is build portability evidence, not hosted Cloudflare execution.

The final accounts smoke passes on fresh rebuilt Docker volumes with both
`accounts` and `accounts-peer` active. It checks CLI secret input/approval, missing
and invalid configuration, pinned retries, browser account/session behavior,
cross-app cookie refusal, control-plane separation, ordinary updates, rotation,
and restart persistence. Review evidence is retained for both Claude and Gemini.

## M8a recovery evidence

Two complete local restore drills passed. The clean-stop run took 27.3 seconds to
snapshot and 10.2 seconds to restore. The forced-stop run took 26.8 seconds and
10.7 seconds, excluding subsequent startup/health waits. These are observations on
this development machine, not capacity or recovery-time guarantees.

The forced-stop snapshot recorded exit 137 for the controller and both notebook
replicas. After restore onto fresh volumes, the accounts approval returned failed
with its original secret revision; explicit retry succeeded. Existing account
sessions, fresh password login, notebook D1 rows, R2 bytes, and Durable Object counts
survived. New writes and approvals succeeded. The literal-dollar gateway credential
survived configuration serialization. Occupied-target refusal, checksum corruption,
incomplete manifests, and configuration drift have regression coverage.

Every archive is checked before target creation and compared against restored volume
contents before the completion receipt. Backups contain plaintext credentials and
require private storage. No writes after a source resumes are included in its prior
snapshot. Cross-version upgrades, concurrent source/clone serving, and shared remote
operation remain unqualified. Claude reviewed the design; Gemini's attempt hit its
provider quota without a verdict. See [review amendments](reviews/m8a-response.md).

The final post-review crash drill also passed: snapshot 26.6 seconds, restore 10.4
seconds, excluding startup waits. One preceding run exhausted Docker's network
address pool because earlier stopped test projects retained their networks. Restore
failed before starting a target. Removing only those old test containers/networks
while retaining volumes and snapshots allowed a fresh-target rerun. No system
network configuration or unrelated Docker workload was changed.
