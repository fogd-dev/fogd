# Prepare a proposed app for preview

`fogd preview prepare` downloads and verifies an exact proposed release without
executing it or changing production. Live preview launch is still under
[issue 2](https://github.com/fogd-dev/fogd/issues/2). Preparation gives that work a
private, identifiable input; it does not provide a running URL or grant execution
permission.

## Prepare an exact submission

Use the operator CLI with the source controller's administrator credentials and
TLS trust configured, as for [artifact review](artifact-review.md):

```sh
fogd preview prepare SUBMISSION_UUID \
  --runtime celld-archive-v9-linux-arm64 \
  --lifetime-seconds 900 \
  --output /private/new-preview
```

Choose a fresh directory whose parent already exists. The command refuses existing
output and uses only administrator GET requests. A deploy credential alone does
not grant access. It downloads the proposed artifact and any current active
baseline, verifies their app/digest and canonical contents, then checks that source
state stayed unchanged throughout the review. Failures retain partial output without a success report. No application code, SQL or Docker operation runs.

The directory contains `review.json`, the `proposed/` artifact, an `active/` baseline
when present, and `preview.json`. Directory permissions are `0700`; metadata files
use `0600`. Application artifacts can contain sensitive source and literal
configuration, so retain the whole directory privately.

`preview.json` records a new preparation UUID, source controller/app/submission and
digest, the review fingerprint, the intended qualified runtime family and its
catalog-entry fingerprint. Standard output includes the preparation SHA-256.
Fingerprints identify bytes; they do not authenticate a publisher or grant access.
A later source submission does not replace the selected artifact.

A preparation for live launch must identify the separate preview runtime catalog.
Archive-family preparations remain valid review inputs but cannot match a preview
runtime's signed target. The internal preparation API accepts an explicit candidate
selection for owned qualification; the CLI accepts qualified entries and exposes
no candidate-enrollment flag. The current preview runtime is still a candidate,
so public live launch remains closed.

## Execution policy and remaining work

Preparation records the intended execution policy. Public launch remains
unavailable. The lifetime is an integer from 60 to 3600 seconds, measured from
signed execution authorization rather than preparation or readiness. This initial profile
accepts HTTP applications; queue and cron declarations refuse preparation.
Required secret names are recorded, but source vault values and credentials are
never copied into the preparation.

Live launch must use fresh empty storage and separate native/resource identities,
preview-only credentials and secrets, an authenticated URL, and no external network
egress. Existing production data, secrets, fleet capacity and activation decisions
must remain untouched. Preview data cannot become production data implicitly.
Resource limits and capacity refusal must be enforced before launch is available;
a container CPU budget does not establish a per-worker CPU quota.

Expiry or explicit teardown must deny new requests and stop preview writers.
Expiry alone cannot report capacity free: fencing and completed reclamation still
need separate confirmation. Interrupted operations must retain their resources and
uncertainty. Production activation remains its own exact-artifact decision.

The current `prepared` result explicitly reports `executionAuthorized: false` and
`capacityReserved: false`. These policy fields are requirements for the remaining
implementation, not evidence that an executing preview is isolated or time-limited.

## Internal deadline component

An [internal supervisor check](https://github.com/fogd-dev/fogd/blob/main/docs/evidence/operator-preview-supervisor.json) exercises
expiry, cancellation, forced termination and missing child-exit observations.
Expired deadlines refuse startup, and retries keep the original absolute deadline.
The child environment defaults to empty application configuration and copies only
explicit own properties; Node can add platform process metadata.

Two current-source, network-disabled, read-only container cases distinguish direct
child exit from verified container stop, including a descendant process. The host
clock and operating-system scheduling remain trusted prerequisites. This is a
launcher component, not a preview execution permission or an application sandbox.
The integration must still bind exact authorization, isolate resources and network
access, protect the URL, and enforce expiry for every service. No preview launch
command is available yet.

## Internal authenticated ingress

The [HTTPS ingress component](https://github.com/fogd-dev/fogd/blob/main/docs/evidence/operator-preview-ingress.json) requires a
preview-specific access key before forwarding application requests. Its sign-in
page identifies the app, preview, submission, release digest and expiry. The
browser session uses a host-only Secure, HttpOnly, SameSite cookie, which the
proxy removes before forwarding. Application cookies and authorization remain
available to the application. Backend responses cannot replace the gateway cookie
or weaken its browser policy.

The component accepts one fixed HTTPS backend with independently supplied trust
and checks the certificate against the preview hostname. It buffers at most 2 MiB
per request, admits at most 16 concurrent requests and bounds upstream requests to
five seconds. A lost write response remains uncertain and is never replayed.
Expiry or revocation denies new requests and interrupts admitted connections;
this does not establish that application writers stopped.

The browser check caught a sign-in failure caused by a referrer policy producing
`Origin: null`. The corrected `same-origin` policy preserves the strict origin
check. See the browser's [Origin header behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin#description).
Headless Chrome verifies sign-in, cookie privacy, a blocked cross-origin fetch,
revocation and the mobile viewport layout. Its self-signed frontend certificate
uses explicit test-context trust assistance; the backend still requires verified
TLS.

This HTTP profile refuses WebSocket/CONNECT upgrades, external redirects and
service workers. Its browser policy constrains subrequests; it is not a complete
browser or hostile-tenant sandbox. The launch coordinator still needs an exact
execution grant, a separate browser origin, fresh storage/native identities,
server-side network isolation and every-service expiry. Public preview launch
remains unavailable.

From a source checkout, run the browser regression separately from the Node-only
suite:

```sh
FOGD_TEST_CHROMIUM=/path/to/chromium \
  node --test packages/cli/test/browser/preview-ingress.test.mjs
```

It uses the declared Playwright development dependency and a preinstalled Chromium
binary. Without the environment override it uses Playwright's installed browser.
The check creates its own headless browser profile and temporary TLS fixture; it
never uses an existing browser session or downloads a browser automatically.

## Internal execution decisions and networks

The [execution and network component check](https://github.com/fogd-dev/fogd/blob/main/docs/evidence/operator-preview-execution.json)
binds a signed owner decision to one preparation, source release, target
installation, configuration, runtime, browser origin and absolute expiry. The
verifier receives its trusted public key independently. Viewer access cannot sign
an execution decision, and an execution decision cannot activate production.

Issuing a decision requires independently verified artifact contents and source
state. The internal coordinator verifies bounded regular files against the
independently retained preparation fingerprint, validates both artifacts and
recomputes their review. It keeps verified proposed bytes in memory; later edits
to the preparation cannot change those bytes. Symlinks, hardlinks, unexpected
members and oversized inputs refuse verification.

Before authenticated source reads, the prepared controller must match the
independently configured endpoint. Two source snapshots must match the recorded
review and remain stable before signing. These reads grant no source lease;
launch must recheck current state before allocating or starting its target.
Runtime admission and fresh target allocation remain coordinator responsibilities.
The initial execution profile refuses queue, cron and Durable
Object declarations; Durable Objects can schedule alarms. Preparation alone can
still record such bindings without executing them.

The network component declares private isolated bridges without host gateway
addresses and disables external DNS forwarding. A controlled Docker fixture
verifies private service lookup and HTTP, an outbound HTTP refusal and an external
DNS refusal against owned endpoints. It does not qualify complete service
membership, ingress routing or a running application sandbox.

The internal coordinator connects verified artifacts and signed decisions to fresh
resources, capacity checks and managed expiry. The foreground launch command
retains ordinary runtime admission; the current candidate is refused. Ordinary preview
admission and complete fresh-app/update acceptance remain open. All
retained deployments are QA fixtures; fresh installation and same-family recovery are the release targets.

## Internal native backend image

The [native backend check](https://github.com/fogd-dev/fogd/blob/main/docs/evidence/operator-preview-backend.json)
exercises a candidate image containing the cached runtime and storage binaries,
the deadline supervisor and fixed backend roles. The launcher derives separate
preview bucket, namespace and node identities, supplies only explicit preview
credentials, and runs native replicas directly without automatic restart.
The controller, gateway and authenticated ingress have signed-role checks
described below. Fresh target enrollment and public launch still need integration.

Two uncached local builds reproduce the candidate image. A fresh private fixture
serves an HTTP application with D1 and R2, reads one acknowledged mutation through
both native replicas, then verifies storage and replica container stops after the
shared deadline. A retry with that expired deadline starts no child. This is a
backend check, not a launched preview, authenticated URL or catalog admission.

The replicas require forced termination after storage exits; native lease writes
remain uncertain. Their stopped containers, storage and network remain retained.
Ordered shutdown, recovery and completed reclamation need separate confirmation
before any reusable-capacity claim. Ordinary runtime admission remains unchanged.

## Internal exact-artifact controller

The [controller check](https://github.com/fogd-dev/fogd/blob/main/docs/evidence/operator-preview-control.json)
verifies a signed execution decision against an independently installed read-only
authority volume. Artifact and secret bytes have separate expected fingerprints.
The controller revalidates the actual artifact and refuses background-capable
declarations before initializing application state. Only explicit preview storage
credentials and secret values enter its target; source administrator credentials
are unnecessary.

The controller activates one exact artifact on fresh storage and exposes only
authenticated route and preview-status reads. It has no upload or approval HTTP
API. Status retains the source submission/digest and records the separate target
submission. Existing controller state refuses startup, including interrupted
activation; no automatic replay or approval retry occurs.

A native fixture verifies that path with D1/R2 writes and both replicas, then
checks expiry and stopped containers. The controller image uses a normalized
filesystem archive; two uncached local builds reproduce its image. The receipt
retains rejected packaging attempts and their timestamp differences. This is a
candidate component check. Shipped runtime admission, public launch, fresh
enrollment and ordered teardown remain open.

## Internal protected native URL

The [protected URL check](https://github.com/fogd-dev/fogd/blob/main/docs/evidence/operator-preview-web.json)
connects the exact-artifact controller, native workerd gateway and authenticated
HTTPS ingress. Each frontend role verifies its signed target and original expiry,
then loads its own TLS/credential bundle from read-only inputs. Neither role
inherits storage credentials. The gateway uses the direct native executable;
ingress verifies the gateway certificate and hostname against separate trust.

A verified HTTPS client signs in, writes through the protected URL to D1/R2 and
reads that mutation through the URL and both native replicas. Unauthenticated
requests and incorrect access keys refuse, and the application never receives the
gateway cookie. Both frontend roles and the native gateway child stop at expiry.
This is an owned private-network fixture using explicit certificate trust, not a
browser trial, public preview command or shipped runtime admission.

Fresh enrollment, capacity checks, full role network placement, ordered teardown
and complete fresh-app/update trials remain required before public launch. The
fixture retains its stopped resources and uncertain native lease cleanup; it
does not establish recovery or reusable capacity.

## Internal host plan and eligibility

The [host-plan check](https://github.com/fogd-dev/fogd/blob/main/docs/evidence/operator-preview-plan.json)
binds a sealed service template to one engine, preparation, runtime image, unique
browser origin and input fingerprints. Replicas attach only to their fleet networks;
only authenticated ingress attaches to the frontend network and publishes a
loopback listener. Frontend roles have no storage credential environment or
writable authority/input mounts. The target configuration fingerprint covers the
template; concrete command deadlines come only from the bound signed decision.

Eligibility checks include stopped resource names, declared ports, existing and
held network ranges, active memory limits and held allocations. Unknown active
memory limits refuse. Matching active role names, images and plan labels count
once against a held envelope; unrelated containers cannot consume that credit.
A supplied held plan remains fully budgeted after its containers stop.

The engine check reads metadata only and reserves nothing. Its fixture supplies
planning fingerprints and an explicit held-plan list; it does not verify actual
artifact/TLS assets or initialize a reservation registry. Fresh enrollment must
recheck under a host lock, admit the runtime, reserve resources, install checked
inputs and verify the actual stopped graph before starting it. Other processes
may still occupy a port after a snapshot.

## Internal host reservations

The internal reservation ledger serializes cooperating local managers through the
existing durable host fence. One configured private root contains a deterministic
directory per engine ID. Explicit fresh initialization refuses existing state and
unregistered preview resources; missing or damaged records are never rebuilt from
an apparently empty engine.

Reservation reads all holds and a complete Docker snapshot under that fence,
checks eligibility, then appends and syncs an immutable hold before returning.
It reserves the declared budget in the ledger, without allocating RAM in Docker,
verifying runtime/assets or granting execution permission. Stopped containers,
expiry and process exit do not release holds. Only the explicit verified memory
retirement described below can release that
budget. Disk, volume/network identities and declared port claims remain retained.

Malformed records or interrupted writes retain the pending marker and files.
Ordinary capacity refusal releases the checking fence and preserves prior holds.
Managers must share the configured root; the fence is local exclusion, not a
distributed engine lock or protection against privileged record deletion.

The [reservation check](evidence/operator-preview-reservations.json) covers
filesystem persistence, competing processes, damaged records and retained holds.
The actual QA engine refuses fresh initialization because earlier preview networks
have no registry entries; those resources and the refusing marker remain retained.
This is refusal evidence, not a successful real-engine enrollment or launch.

## Internal stopped allocation

The earlier [stopped-allocation check](evidence/operator-preview-stopped-allocation.json)
covers nine runtime containers, four bridges and twelve named volumes under an
existing capacity hold and host fence. The current plan also includes the
networkless input installer described below. Allocation checks the signed target and original deadline,
the independently supplied immutable image ID, and actual Docker configuration.
No service starts during allocation. Trust/input volumes remain empty until the
separate installation step; runtime execution admission remains unavailable.

A durable pending journal precedes the first Docker creation. Each resource has a
fresh allocation identity; the final readback verifies limits, restart policy,
private network placement, loopback publishing, no-copy mounts and read-only
authority/input permissions. It rejects unexpected resources and foreign mounts
or namespace attachments. Completion records the actual resource identities and
configuration fingerprint; capacity remains held.

An uncertain Docker result or failed verification retains resources, journal and
host fence. The first fixture remains fenced after rejecting Docker's empty mount
driver descriptor. The corrected check accepts that empty representation and
still rejects nonempty driver settings. A separate fresh-engine fixture completes
allocation while preserving its 400 prior stopped QA containers. Neither fixture
starts application code or establishes launch readiness.

After the successful fixture's original grant expires, its unchanged hold still
refuses a second full envelope while all 409 containers remain stopped.

Shipped runtime admission, final launch checks, ordered teardown and full
fresh-app/update browser trials remain open.

## Internal checked input installation

The [input-installation check](evidence/operator-preview-input-installation.json)
installs exact artifact, preview-secret and role-specific TLS bytes without starting
the application. The sealed plan includes ten containers: nine runtime roles and
one fixed input installer. Its declared memory envelope is 4,992 MiB plus 1 GiB
headroom. The installer has no network attachments or storage credential
environment. Its writable mounts cover only the six authority/input volumes;
application-facing roles retain read-only mounts.

The host snapshots and validates artifact digests/declarations, required secrets,
the signed target, TLS hostname/expiry, upstream trust and every sealed input
fingerprint before starting the installer. Artifact validation executes no worker
code or SQL. A pending journal precedes the start, and the one-shot installer
refuses existing files. It writes and syncs fixed filenames, then exits.

Completion requires a confirmed clean installer exit, exact readback through the
stopped services' read-only mounts and a fresh graph check. Every application
service must remain never-started. Ambiguous results retain the pending operation,
capacity hold and files without replay. Installed inputs grant no execution
permission: runtime admission, source recheck, launch and teardown gates remain.

## Internal ordered teardown and memory retirement

The [teardown check](evidence/operator-preview-teardown.json) stops verified
container IDs in four groups: ingress; gateway, controller and initialization
roles; native writers; then MinIO. A fresh graph observation must confirm each
group stopped before the next group runs. If storage-dependent roles had started, MinIO must
remain running until their confirmed exit for shutdown to count as ordered.
Missing observations or ambiguous commands retain the host fence and hold without
replay. Successful Docker command output alone is insufficient.

Signature/target inspection can identify an expired allocation for shutdown; it
returns no Docker creation commands and grants no execution permission. Live
execution authorization still refuses an expired decision. Teardown does not
refresh its original deadline.

Stopping keeps the memory budget held. Explicit retirement additionally requires
the original grant to have expired, an ordered teardown journal, a fresh confirmed
stopped graph and matching resource identities. A durable retirement record then
removes that plan from memory admission accounting. Historical hold records and
all containers, networks, volumes and data remain retained. Managed operations
refuse the retired hold, and existing resources still prevent namespace reuse.

This releases a software memory budget, not disk or port claims. It establishes
neither native lease cleanup nor data recovery. The live fixture covers manual
ordered shutdown; automatic expiry ordering, public lifecycle commands and full
fresh-app/update browser acceptance remain open.

## Internal startup inspection

The [startup inspection check](evidence/operator-preview-startup-inspection.json)
reopens the verified preparation, then checks the installed input package under
the host fence. It checks the original live grant, active hold, completed
installation and exact stopped graph. It then copies the actual application-facing
authority/input mounts again; a previous installation readback is insufficient.

Source observations use only the independently configured administrator endpoint.
The proposal and active baseline must still match the prepared review, and private
consistency guards must agree between two GET snapshots. Credentials never follow an endpoint
from prepared metadata. The final graph, original deadline and current memory
eligibility are checked after those observations. Application code and SQL remain
unexecuted throughout inspection.

This is a point-in-time observation, not a reusable start authorization. No
application service starts, runtime admission remains closed, and the original
expiry cannot be extended. Inspection releases its checking fence after a refusal
because it performs no Docker mutations; it retains the allocation and hold.
Actual startup must integrate these checks with runtime admission, ordered service
readiness and automatic expiry shutdown before a public launch is available.

## Internal managed lifecycle

The [managed lifecycle check](evidence/operator-preview-lifecycle.json) uses an
explicit candidate runtime from the [preview catalog](../packages/cli/src/preview/runtime-catalog.json).
Ordinary enrollment refuses that candidate. Its immutable image and catalog hash
must match the signed target; all cataloged source programs are copied from the
stopped installer and rehashed without executing an image inspector or copying
dependency links outside their package directory.

The host coordinator repeats source and capacity checks before recording a
durable startup intent. It starts storage, completes bucket initialization, then
starts native replicas, the exact-artifact controller, gateway and ingress. Fresh
graph observations and read-only readiness probes precede each later phase.
Readiness probes use storage health, TCP/TLS connections, authenticated controller
identity and unauthenticated ingress refusal; they never invoke an app handler.
An unknown start or observation retains the fence, resources and hold without
replay. Interrupted startup remains fenced and uses the original service deadlines.

The managed entry point schedules shutdown before returning readiness. It begins
ordered teardown thirty seconds before the original deadline, or on cancellation
of a ready preview through its supplied signal. Its owner must observe completion.
Setup and the shutdown interval consume the original lifetime; readiness reports
the earlier shutdown time separately from the original expiry.
The original per-service deadline remains a fallback; manager loss and arbitrary
Docker stalls do not establish ordered shutdown. Memory retirement stays explicit
and requires the original expiry and complete stopped-state proof.

The foreground launch command refuses this candidate; ordinary enrollment remains closed.
Full fresh-app/update browser trials, manager-loss recovery, native lease cleanup
and data recovery remain open. Ordinary previews also need recovery qualification
and browser withdrawal controls. Default cron admission remains closed.

## Preview host profiles

`fogd preview profile init` initializes one fresh local ledger and one engine-wide
retained storage policy. It grants no runtime or execution permission. Source
administrator credentials, TLS keys and viewer credentials are not needed.

On the selected Linux Docker host, create a fresh root-owned `0700` directory on
the ext4 filesystem that hosts Docker data. For a host using the default Docker
root, an example is:

```sh
sudo mkdir --mode=0700 /var/lib/docker/fogd-previews
```

Existing directories and registries need inspection and recovery through their
original records. Profile initialization requires an empty storage root and an
absent canonical storage registry; it cannot adopt or reset an existing budget.
The [storage host requirements](#internal-bounded-persistent-storage) still apply.

From a private local parent directory, select the Docker context and SSH alias
explicitly and set the retained project limit:

```sh
fogd preview profile init \
  --docker-context owned-linux \
  --storage-host owned-linux \
  --storage-root /var/lib/docker/fogd-previews \
  --max-projects 2 \
  --output /private/preview-profile
```

Both transports must reach the same engine. The SSH alias has the same
noninteractive authentication, known-host and root Python requirements as the
foreground launch transport. The command does not start containers or initialize
application filesystems. The limit charges retained preview storage after stop;
it is separate from memory admission and does not reserve the whole limit upfront.

Keep the returned profile fingerprint independently from the private profile
directory. The profile binds its original path, local ledger, Docker context,
engine and exact storage policy. It contains a durable initialization intent and
a completion record. Relocation, altered metadata, public file permissions and
partial output refuse. After a failed initialization, preserve local files and
host metadata; repeating the same output cannot replay host initialization.
Partial profile completion recovery remains open.

```sh
fogd preview profile status /private/preview-profile \
  --expected-profile ORIGINAL_PROFILE_SHA256 \
  --storage-host owned-linux
```

Status verifies the current engine, registered preview resources, local memory
holds and exact storage policy. Its bounded output distinguishes historical and
active memory reservations from held storage charges and remaining storage slots.
A pending operation, changed engine or policy refuses. Status releases only its
own checking fence; it never clears another operation or grants execution.

The [profile qualification](evidence/operator-preview-profile.json) includes real
CLI initialization/status checks with controlled Docker/SSH processes and native
refusal against an existing used QA storage root. Independent raw reads verify
that the native refusal retains registry hashes, read-only SQLite/binary data and
the stopped fixture. A separate cached-base Linux ARM64 engine verifies actual
profile initialization and status, private ledger/completion fingerprints and
canonical policy ownership. A second output cannot reset that policy. The fresh
trial leaves zero application images, containers, volumes or storage holds; it
qualifies metadata setup only. Ordinary preview and cron admission stay closed.

## Profile-backed storage and request setup

The [setup command reference](preview-setup.md) connects a host profile, exact
preparation, bounded storage receipt and private TLS/settings files. Separate
commands provision storage and generate signed launch inputs; neither reserves
memory or starts application services. The storage-request fingerprint binds its
original profile/preparation intent and filesystem receipt. Request generation
rechecks actual storage and source, then creates fresh credentials and authority.

Both public commands keep ordinary runtime admission. The shipped candidate is
refused before Docker or SSH calls; explicit internal qualification APIs retain
separate candidate access. Partial setup and existing charges remain retained.
Public storage inspection/reconciliation can complete missing local receipt or
completion records against already settled, empty host storage using a reviewed
fingerprint. It requires no source credentials or runtime admission and cannot
repair corrupt metadata or clear pending host/profile fences. See the
[recovery procedure](preview-setup.md#inspect-and-complete-retained-local-storage-setup).
Public request creation is implemented; ordinary preview acceptance remains open.

## Internal owner launch requests

The [launch-request API](../packages/cli/src/preview/launch-request.mjs) creates
private, signed launch inputs from a verified preparation, already admitted empty
storage, explicit runtime/placement and owner-supplied TLS. It generates a fresh
signing authority, storage password, gateway token and viewer access key. It checks
the actual prepared artifact and current source through an independently supplied
owner environment. Request creation reserves no memory and starts no containers;
the admitted storage charge remains held.

Keep the returned request fingerprint separately from its private directory. The
request contains launch inputs, viewer access information and a completion record.
The signing private key and source-owner credentials are absent. The private files
still contain preview credentials and TLS keys, so retain their owner-only modes.
Preserve both preparation and request directories at their original paths.

The reader requires the original fingerprint and verifies completion, permissions,
signature, package bindings, expiry and runtime admission. Relocation, altered or
incomplete files refuse. An existing private owner-control subdirectory can be
read, but the coordinator's fresh-control check prevents another launch through
that directory. Request creation and reading cannot renew the original expiry.
After a partial write, retain the directory for inspection; setup cannot overwrite
or repair it implicitly.

The [native request qualification](evidence/operator-preview-launch-request.json)
feeds generated inputs through the coordinator on a Linux ARM64 QA engine. It
verifies protected TLS, initially empty D1/R2, an acknowledged write, both replica
reads, owner stop and post-expiry memory retirement. All twenty containers remain
stopped and retained, including ten prior peers. Independent checks verify their
configuration and the earlier preview's 68 file digests/inodes. Both fixed-size
storage reservations remain charged, exhausting this QA registry's two-project
limit. The source is an owned HTTP fixture; full browser and real-production
preservation acceptance remain open.

This API retains the explicit internal candidate gate. The profile-backed request
command uses the same creator; profile setup grants no execution permission.

## Foreground launch command

`fogd preview launch` accepts only qualified preview runtimes. The current candidate
is refused before source or host effects, so live public use remains closed.
The [profile-backed request command](preview-setup.md#create-a-launch-request)
creates its inputs. Profile initialization alone grants no execution permission.

```sh
fogd preview launch \
  --request /private/preview-request \
  --expected-request ORIGINAL_REQUEST_SHA256 \
  --storage-host owned-linux
```

The request binds the original preparation path, Docker context, engine and signed
target. Supply source administrator credentials and TLS trust independently in the
command environment, as for preparation. The source endpoint must still match the
original review. Neither request metadata nor a CLI flag can enable candidate
admission.

`--storage-host` names an independently configured SSH alias for the same Linux
Docker host. Its host key must already be trusted, authentication must work without
prompts, and `sudo -n python3` must run as root. The fixed transport sends only the
pinned storage worker and its JSON input over stdin. It disables agent forwarding
and configured port forwarding and removes source/Docker environment variables
from the local SSH process. Existing [storage host requirements](#internal-bounded-persistent-storage)
still apply.

The command emits one JSON line for readiness and one for completed stop. Readiness
includes the original expiry, earlier shutdown time and private owner-control
location. Viewer credentials stay in the private access file. Keep the process
running while using the preview: it owns source monitoring and ordered shutdown.
SIGINT or SIGTERM requests cancellation; after readiness, the command waits for
managed stop. Interrupted provisioning retains its component evidence and any
allocated resources. Lost readiness output also requests stop. An ambiguous
provisioning result retains its fence and resources without cleanup or replay. Failure to prove storage ordering
reports a nonzero exit even when all roles are stopped.

The command retains memory and storage charges after stop. Use the separate owner
commands for status and explicit post-expiry memory retirement. Manager loss,
forced termination and arbitrary Docker stalls remain recovery gaps.

The [foreground/transport qualification](evidence/operator-preview-foreground.json)
combines process-model launch tests, real CLI candidate refusal and actual OpenSSH
read-only inspection on the retained Linux ARM64 QA engine. The native transport
check verifies existing storage receipts and data without launching another app;
it does not qualify a native foreground launch or ordinary runtime admission.

## Internal coordinated provisioning and launch

The [launch coordinator](../packages/cli/src/preview/launch.mjs) connects capacity
reservation, stopped allocation, checked input installation and the managed
lifecycle in one fresh attempt. Its inputs include an already admitted storage
receipt in the sealed plan, a signed execution envelope, preview-only input bundle,
initialized host ledger and independently selected transports:

```js
const active = await provisionAndRunPreview({
  root: hostLedgerRoot, plan, envelope, bundle,
  directory: preparationDirectory, env: sourceOwnerEnvironment,
  runtime: previewRuntimeId,
  run: ownerDocker, runStorageHost: privilegedStorageTransport,
  publicKey, expectedGrantSha256, secretValues,
  ownerControl: { directory: freshOwnerDirectory, dockerContext },
  signal: stopSignal,
});
// Readiness includes the allocation, URL, original expiry and owner-control path.
const stopped = await active.completion;
```

Ordinary runtime admission applies before reservation. Owned candidate qualification
requires an explicit internal API option; there is no CLI bypass. The coordinator
checks the signed bundle, actual preparation files and current source before host
effects. It preserves the checked package and service configuration across later
caller edits. Artifact file-list order can differ while the verified path/data
pairs and signed package bytes stay bound to the same release.

The owner-control location must be fresh and outside preparation and host-ledger
state. After stopped allocation, the coordinator durably writes those controls
before starting the input installer. They can support inspection and recovery even
when a later phase fails. Readiness follows verified service startup with the
manager already watching for expiry, source withdrawal and owner stop.

Failures retain component journals, holds, resources and uncertainty. A repeated
attempt cannot replay an uncertain allocation. If reservation or allocation stops
before control creation, preserve the host ledger for explicit recovery; the
coordinator does not reclaim that reservation automatically.

The [native coordinator qualification](evidence/operator-preview-launch-coordinator.json)
uses one dedicated Linux ARM64 Docker engine and a pre-admitted empty filesystem.
It verifies protected TLS HTTP, initially empty D1/R2 data, an acknowledged write
and both live replica reads. Public owner stop works without source credentials;
the manager observes the same ordered completion. Explicit memory retirement after
the original expiry leaves the storage charge, data and all physical resources
retained. Separate raw reads verify signed bindings, resource limits, volume
sources and 68 retained file digests. The source is an owned HTTP fixture. Post-stop
D1 restoration and full browser/production-preservation acceptance remain open.

Ordinary runtime admission and complete native/browser acceptance remain open; the foreground entrypoint keeps that admission gate.
Manager-loss recovery, unfinished reservation cleanup and broader artifact-size/density measurements also remain
open. Default cron admission stays closed.

## Internal owner withdrawal and source monitoring

The [withdrawal check](evidence/operator-preview-withdrawal.json) adds durable
local-owner stop requests. The first request is immutable and binds the original
allocation, reservation, plan, grant, resource graph and expiry. A request grants
no execution permission, frees no memory and prevents a later startup of that
target. Existing source credentials are unnecessary for an owner stop.

The manager checks for owner requests and revalidates its cached, verified source
review against the independently configured administrator endpoint. A rejected
proposal, changed active baseline, refused source access or unverifiable snapshot
causes ordered shutdown. Source checks run independently of expiry and can be
cancelled; an unanswered source read cannot hold up scheduled shutdown. An idle
intent check performs no Docker calls.

An owner stop and the manager converge on the same completed teardown. Repeated
stop calls validate the original complete phase proof and a fresh stopped graph,
then return the existing result without another Docker stop or intent write.
This also works after explicit memory retirement. Status reports current memory
accounting separately from the historical teardown record.

Partial, malformed or unordered proofs cannot become a fresh cleanup attempt or
an ordered reclamation claim. Unknown effects retain their fence and hold. A
pending-fence refusal can be observed again because it occurred before any effect;
uncertain commands and partial writes are never retried. Public launch and browser
decline/revocation controls remain open.

## Owner status, stop and memory retirement

The owner CLI controls an existing candidate allocation through its private owner
control directory. The internal managed coordinator can create that directory
before startup. The gated foreground launch entrypoint uses the same coordinator;
ordinary preview-runtime admission remains closed.
The [owner-control check](evidence/operator-preview-owner-controls.json) records
its bounded qualification.

```sh
fogd preview status ALLOCATION_UUID --control /private/preview-owner
fogd preview stop ALLOCATION_UUID --control /private/preview-owner --reason declined
fogd preview retire ALLOCATION_UUID --control /private/preview-owner
```

Keep the control directory private. It contains the signed target and the preview
storage/gateway credentials needed to verify the graph. It excludes source
administrator credentials, signing keys, TLS private keys and viewer access keys.
Owner commands need local filesystem and Docker access, without source credentials.
They select the directory's explicit Docker context, ignore ambient Docker selection
and check the engine identity before acquiring the host operation fence. They do
not change the global Docker context.

`status` checks actual resource identities and reports process state, the original
expiry, stop intent, ordered completion and current memory accounting. It does not
invoke an application handler; `health: "not-assessed"` remains explicit. A busy
host operation reports `state: "pending"`, `runtimeObserved: false` and a nonzero
exit status without clearing that operation's fence.

`stop` records the first owner reason and converges with the manager's ordered
shutdown. Repeated completed stops recheck the graph and preserve the original
proof without repeating Docker mutations. Unknown results remain fenced and must
not be retried as a fresh operation.

`retire` releases only the software memory budget after the original expiry and
verified ordered shutdown. It refuses early retirement. Repeated retirement
observes the existing result. Containers, data, volumes, networks, ports and names
remain retained; this command establishes neither namespace reuse nor physical
storage reclamation. Public launch, ordinary runtime admission and browser
withdrawal controls remain open.

## Preview temporary storage and log retention

New internal plans seal explicit temporary-storage and log-retention settings for
every role. The [resource-policy check](evidence/operator-preview-resource-policy.json)
records the realized Docker configuration and native exhaustion checks. The
[plan constructor](../packages/cli/src/preview/plan.mjs) owns the fixed profile;
changing those settings changes the signed target.

The temporary `/tmp` filesystem has separate byte and inode limits. Exhausting
either returns `ENOSPC` in the native check. Its memory use remains within the
container memory limit; temporary files disappear when the container stops.
See [Docker's tmpfs behavior](https://docs.docker.com/engine/storage/tmpfs/).
Application data remains on separate retained volumes.

Every role explicitly selects JSON log rotation and blocking delivery. The graph
check refuses missing, unbounded, alternative or additional logging options,
including environment values added as log metadata. Rotation removes older logs;
it is a retention policy, not a complete audit archive or a strict physical-disk
quota. See [Docker's JSON logging options](https://docs.docker.com/engine/logging/drivers/json-file/).
Blocking delivery can slow a process when the logging sink cannot keep up.

Historical QA plans remain verifiable for owner status, stop and memory
retirement. They cannot create new containers or start a preview with their old
resource policy. No existing user installation needs migration, and no retained
container is reconfigured by this change.

New schema-3 plans bind persistent volumes to a bounded filesystem as described
below. Host free-space checks alone cannot bound a live writer. Ordinary preview
admission and public launch remain closed until the remaining acceptance gates
pass. Default cron admission remains closed.

## Internal bounded persistent storage

The [persistent-storage component](evidence/operator-preview-persistent-storage.json)
provisions a fixed-size ext4 filesystem in a newly created, preallocated backing
file on the Linux Docker host. Its profile reserves a 1 GiB backing file and
creates separate directories for preview data and authority inputs. Filesystem
metadata consumes part of that space. A native Docker writer reaches `ENOSPC`
inside this filesystem while the outer backing filesystem still has space.

The internal host worker requires root, Python 3, Docker's local Unix socket,
util-linux and e2fsprogs. New provisioning requires explicit enrollment of a fresh
root-owned private directory on Docker's ext4 backing filesystem. The
caller supplies an independently selected host transport; this is not a public
storage-provisioning command. Before creating files, the worker checks that the
local Docker engine matches the requested identity.

Provisioning exclusively creates a fresh project directory and regular file. It
formats that new file through its held descriptor, then attaches and mounts it;
it never formats an existing block device. Exclusive stage records retain file,
filesystem, loop-device, mount and directory identities. Failed or unknown
operations retain their resources and cannot restart provisioning into the same
directory. Inspection performs no provisioning or cleanup.

The native check retains a marker and sampled file across a controlled
unmount/remount. A missing mount, wrong engine or repeated provisioning request
refuses ordinary storage inspection. Explicit read-only recovery after controlled
mount loss is described below. Host-restart recovery, automatic reattachment and
application consistency after disk exhaustion remain unqualified.
All filesystem images, devices, mounts, Docker volumes and containers remain
retained. The component has no resize, delete or reclamation operation.

The storage-bound lifecycle below connects these identities to the signed target,
realized Docker volume sources and startup checks. Historical schema-2 QA plans
retain their original unbounded volume definitions for owner controls. Ordinary
preview admission, public launch and default cron admission remain closed. See Docker's
[block-device volume example](https://docs.docker.com/engine/storage/volumes/#block-storage-devices)
and the Linux [preallocation contract](https://man7.org/linux/man-pages/man2/fallocate.2.html)
for the underlying mechanisms.

## Storage-bound preview lifecycle

The [bounded-preview integration](evidence/operator-preview-bounded-storage.json)
connects the storage component to new schema-3 plans, Docker volumes and startup.
The signed target covers the storage receipt, source engine, filesystem/file
identities, worker fingerprint and each role's source directory. Changing a valid
storage receipt changes the target and requires a new execution decision.

Allocation checks the actual host filesystem and empty role directories before
creating resources. Input installation repeats that check before writing through
the fixed networkless installer. Startup requires empty application-data
directories, verified installed inputs and a matching mounted filesystem. Each
service phase and readiness observation checks storage again. A missing or changed
mount cannot silently fall back to an unbounded directory.

The realized Docker graph must match every local-volume driver option and source
path. Graph verification refuses foreign volumes, bind mounts or device mappings
that reference the sealed storage directory or loop device. The worker checks the actual local Docker
engine through its Unix socket; the caller supplies the privileged host transport
separately from source credentials and viewer access.

A storage refusal before effects releases that operation's checking fence. Once
an operation has issued effects, unknown outcomes retain the writing fence, hold
and resources. No failure automatically formats, reattaches or retries storage.
Owner status, stop and explicit memory retirement remain available through their
private Docker control directory without the privileged storage transport. Those
controls inspect process/resource state; they do not assert filesystem health or
release retained disk space.

Historical QA plans remain readable and stoppable; fresh container realization
and startup require schema 3 with admitted storage. There are no user
installations to migrate. Ordinary preview admission still needs recovery
qualification and full fresh-app/update browser trials. Public launch and default cron admission remain closed.


## Backing-space admission and retained charges

The [storage-admission check](evidence/operator-preview-storage-admission.json)
serializes new provisioning through one registry for the local Docker engine and
one explicitly enrolled storage root. Choosing another directory cannot create a
second budget. The root must share Docker's backing filesystem, so admission can
observe space needed for Docker logs and metadata as well as preview images.

Each project receives a durable reservation before its filesystem is created.
The configured project limit, current available bytes and free inodes all gate
provisioning. Charges include the backing image and a conservative metadata
allowance; the [host policy](../packages/cli/src/preview/storage/admission.py)
defines those quantities. A count of remaining projects is a logical limit;
current backing space is reported separately and can close admission sooner.

Images are preallocated and written before use to convert unwritten extents.
Later filesystem writes therefore keep the backing file's allocation stable in
the native check. Provisioning rechecks headroom before reporting success.
Concurrent requests hold a process lock on the private registry directory as well
as an exclusive durable fence. The lock ends with its owning process; the fence
survives process loss. Native provisioning helpers run under a supervisor that
retains the lock until the helper exits, including after caller loss. A known
refusal before reservation releases only its own
checking fence. Partial reservation writes or uncertain provisioning retain both
the charge and the fence; no PID or elapsed time causes automatic release.
Ordinary storage inspection refuses its own pending prepare fence, so a caller
cannot turn an uncertain provisioning result into an execution receipt. Only the
original provisioner or an explicit matching reconciliation can inspect through
that fence.

Stopping a preview, expiry and software memory retirement never remove storage
reservations. The native lifecycle confirms that the configured storage limit
remains exhausted after ordered stop and memory retirement. Existing application
data and all image/device/mount resources remain retained. The admission registry
has no reset, resize or reclamation command.

Older unadmitted QA storage remains available for historical inspection and owner
controls. New plans require an admitted storage receipt. This remains an internal
host API; public provisioning remains unavailable and the foreground launch
command keeps ordinary runtime admission closed. Unrelated host
writers and hypervisor storage are outside this budget, and a space observation
is not a storage-health guarantee. Corrupt initialization metadata, incomplete recovery
sequences, writable application restoration and ordinary preview acceptance remain
open; default cron admission remains closed.

### Recover unused admission initialization

An interrupted first initialization can leave a private registry before its policy
and empty holds directory are complete. The owner can inspect that state through
the [admission API](../packages/cli/src/preview/storage-admission.mjs):

```js
const input = { root, engineId, runHost };
const inspected = await inspectPreviewStorageAdmissionInitialization(input);
const status = await recoverPreviewStorageAdmissionInitialization(input, {
  maxProjects: expectedUnusedProjectLimit,
  registrySha256: inspected.sha256,
});
```

Review the returned state and preserve its fingerprint with the selected limit in
private owner records. Recovery requires the same registry/root identities, an
empty managed root, no reservations and exclusive registry ownership. It refuses
unknown registry entries, foreign fences and malformed published policies. An
existing policy keeps its bytes, identity, profile ID and configured limit. If no
policy was published, the explicit limit selects the new policy.

Recovery completes missing initialization metadata and appends
`initialization.recovered.json`, binding the reviewed state, resulting policy and
original initialization fence. It syncs the registry's parent before releasing
only that fence. It creates no preview filesystem or application resources and
cannot reset a used budget.

A completed recovery can repeat with the original fingerprint and limit, including
after a lost response. If recovery stops before writing its acknowledgment,
inspect and review the new state before retrying. Published policy and hold
identities remain preserved. A malformed acknowledgment refuses recovery.

The [initialization-recovery qualification](evidence/operator-preview-storage-initialization-recovery.json)
covers owned process loss after registry, fence, holds and policy creation, plus
loss after the recovery acknowledgment. Five isolated unused registries exercise
the final source. Independent raw reads verify identities, policy bytes, original
snapshot/fence bindings and empty roots/holds. The real QA budget and application
data remain unchanged. This qualifies metadata recovery after process loss;
power-loss consistency, corrupt-record repair and application restoration remain
separate gates. Public launch and default cron admission stay closed.

### Record publication and interrupted sequences

The storage worker publishes each new JSON record only after writing and syncing
its complete contents. It uses a private unnamed inode, links it to the requested
name without replacing any existing entry, then syncs the parent directory before
reporting success. Records are bounded to 64 KiB and remain root-owned, mode 600,
with one link in a checked private directory. No named staging file is created.

This requires Linux anonymous-file support and procfs descriptor links on the
selected host. Unsupported hosts refuse the write; there is no direct-write
fallback. See the [Linux anonymous-file publication contract](https://man7.org/linux/man-pages/man2/open.2.html)
and [Python directory-relative links](https://docs.python.org/3/library/os.html#os.link).

The [record-publication qualification](evidence/operator-preview-storage-record-publication.json)
checks five process-interruption boundaries on Docker's backing ext4 filesystem,
a concurrent create-only collision and refusal on the retained read-only view.
A negative control using the previous direct writer exposes a truncated record
and fails the same absence check. Independent reads verify the resulting files
and unchanged QA data, loops, mounts and real admission registry.

Individual record publication is not a transaction across records. Interruption
between the global recovery fence and its intent can still leave an incomplete
sequence. Unused admission initialization has the explicit recovery path above. Keep its records and resources for explicit
recovery; never repeat uncertain provisioning. The qualification covers process
loss and injected sync errors, not power-loss durability or application consistency.

### Reconcile completed provisioning

An explicit reconciliation can acknowledge completed storage when the provisioner
exited before clearing its fence. It requires the exact operation UUID from the
private `operation.pending.json` record and the independently selected engine,
storage root and project. The [internal storage API](../packages/cli/src/preview/storage.mjs)
exports `reconcilePreviewStorage`; it uses the same privileged host transport as
provisioning:

```js
const receipt = await reconcilePreviewStorage(
  { root, project, engineId, runHost },
  { operation: reviewedOperationUuid },
);
```

The operation refuses while another current worker holds the registry lock.
Use one worker version for the selected engine; older workers do not participate
in this lock. Reconciliation checks the completed manifest, reservation, backing
file, loop device, mount, role identities and available headroom. It writes a
private acknowledgment before releasing only the matching fence. Repeating that
exact acknowledgment checks the same storage again. A different or newer fence,
changed acknowledgment, missing completion or failed inspection refuses and
retains the records. Do not delete a fence or retry provisioning to recover it.

This operation never formats, mounts, recreates or deletes storage and never
releases a reservation. Its receipt grants no application execution permission.
Quarantine can isolate an interrupted reservation; recovering its data or
reattaching missing mounts requires a separate workflow. The [reconciliation qualification](evidence/operator-preview-storage-reconciliation.json)
uses isolated recovery records referencing the retained QA filesystems; the real
engine admission registry and application data remain unchanged.

### Quarantine interrupted provisioning

An owner can quarantine an interrupted project while retaining all its storage
and its full reservation. The operation requires a valid durable hold and the
exact original prepare-operation UUID. It first excludes live workers and their
supervised native helpers. It then writes a private quarantine record before
releasing only the matching global fence. It never deletes or modifies the
project's files, devices, mounts or application data.

The [admission API](../packages/cli/src/preview/storage-admission.mjs) exports
`quarantinePreviewStorage` through the same independently selected privileged
host transport:

```js
const admission = await quarantinePreviewStorage(
  { root, project, engineId, runHost },
  { operation: reviewedOperationUuid },
);
```

A quarantined project remains charged and cannot supply storage for new execution.
Storage inspection and completed-provisioning reconciliation refuse that project.
Repeating its exact quarantine acknowledgment preserves the record. A different
or newer fence refuses; neither process identifiers nor elapsed time clear it.
A missing or damaged hold needs the explicit repair below. Partial quarantine or
repair records and unfinished registry initialization remain blocked for separate
repair. There is no unquarantine or reclamation API.

Another fresh project can proceed only within the remaining project limit and
physical headroom. Admission conservatively reserves a full additional charge
and the host metadata inode allowance for every quarantined project, even when
its bytes have not yet been allocated. Status reports quarantined charges as a
subset of retained charges, not freed capacity. The [quarantine qualification](evidence/operator-preview-storage-quarantine.json)
covers retained partial metadata, caller loss with a surviving helper, exact
capacity boundaries and actual retained filesystems through isolated recovery
records. It does not qualify restoration of interrupted application data or a
host reboot. Public launch and default cron admission remain closed.

### Repair a missing or damaged hold

An owner can replace an unreadable reservation in admission accounting with a
conservative quarantined charge, while preserving the original hold file. Repair
requires a valid policy and the exact pending prepare-operation UUID. Review the
original hold on the independently selected host: the request must contain its
exact raw SHA-256 digest, or explicit `null` when the hold is absent. Omission does
not mean absence. A valid hold uses ordinary quarantine instead.

The [admission API](../packages/cli/src/preview/storage-admission.mjs) exports
`repairPreviewStorageHold`:

```js
const admission = await repairPreviewStorageHold(
  { root, project, engineId, runHost },
  { operation: reviewedOperationUuid, holdSha256: reviewedHoldSha256 },
);
```

Repair excludes live workers and helpers, then appends a separate private repair
record before releasing only the matching fence. It preserves the damaged
file's bytes and identity, or preserves its absence. The record supplies one
full reservation and permanently quarantines that project. All peer records and
the project limit must validate before the fence can be released. Repeating the
exact repair checks the same record and original bytes without rewriting either.

Changed bytes or identity, a newly appearing original file, a different operation,
unsafe file permissions or a partial repair record refuse further admission.
The repair never formats, mounts, restores or authorizes application storage.
The [hold-repair qualification](evidence/operator-preview-storage-hold-repair.json)
exits an owned worker after a partial hold write and before hold creation, then
verifies repair through the assembled host transport and independent raw reads.
Its fixtures contain only metadata. The real engine registry, retained application
storage and prior QA containers remain unchanged. Data and host recovery, partial
repair-record recovery and public launch remain open; default cron admission
remains closed.

### Read retained data after mount loss

An owner can recover a read-only view of a completed admitted filesystem after
its mount is lost. The operation verifies the original storage receipt, actual
backing file, filesystem UUID, retained reservation and role inodes. It never
formats storage or starts application code. Quarantined storage can remain
quarantined while its completed filesystem is read; damaged or incomplete storage
without a verifiable completed manifest refuses recovery.

The [recovery API](../packages/cli/src/preview/storage-recovery.mjs) uses the same
independently selected privileged host transport:

```js
const options = {
  recoveryId: ownerChosenUuid,
  storageSha256: originalStorageReceipt.sha256,
};
const view = await recoverPreviewStorageReadOnly(
  { root, project, engineId, runHost }, options,
);
```

Preserve those options with the operation's private owner records. A successful
view exposes the recovered path through `view.recovery.mount.target`; it is a
recovery receipt, not a provisioning receipt or execution permission. Ordinary
storage inspection refuses the read-only mount, and fresh preview startup cannot
use it. Data promotion and application restoration require separate decisions.

Before mounting, the worker refuses live or automatically restarting containers
that reference the project, its backing file, loop device or bound local volumes.
It also refuses live privileged/device-enabled containers and unknown volume
plugins when a referencing container is live or configured to restart. Unrelated ordinary containers
keep running. The registry lock and native-helper supervisor coordinate current
fogd workers; these observations do not freeze other host administrators.

Recovery retains an existing exact loop association, or attaches a read-only loop
when none exists. It mounts with `ro,noload` and checks all host aliases for the
same read-only filesystem root. The [Linux ext4 documentation](https://docs.kernel.org/admin-guide/ext4.html#options)
explains why read-only access also needs journal replay disabled. Reusing an
existing writable loop does not make that block device immutable; the recovered
mount is read-only. Skipping journal replay does not establish application
consistency or repair a damaged filesystem.

Unknown effects retain the durable intent and global fence without replaying the
mount. `inspectPreviewStorageRecovery` checks a recorded completed view.
`reconcilePreviewStorageRecovery` explicitly verifies an existing read-only view
and records completion without mounting it again. It cannot acknowledge a missing
or invalid view, a partial intent, or another operation's fence. Repeating an
acknowledged recovery checks the same records and view. A later mount-loss event
needs a new owner-selected recovery UUID; it cannot bypass an unfinished earlier
operation.

A truncated or noncanonical completion file can be repaired explicitly when its
original intent and read-only view still verify:

```js
const view = await repairPreviewStorageRecoveryCompletion(
  { root, project, engineId, runHost },
  { ...options, completionSha256: independentlyReviewedDamagedFileSha256 },
);
```

The digest names the raw bytes of `recovery-<recoveryId>.complete.json` on the
selected host. Review and retain those bytes before requesting repair. The worker
requires the original pending fence, exclusive ownership of the registry lock and
fresh filesystem/writer checks. It preserves the damaged file and appends
`recovery-<recoveryId>.repair.json`, binding its bytes and inode to the verified
view before releasing that fence. Inspection and repeated recovery check both the
retained evidence and the current view. No mount or application operation repeats.

Canonical JSON completion records, including conflicting reports, refuse repair.
Missing completion files use reconciliation. Missing or damaged intents and partial
repair acknowledgments remain fenced; this operation cannot repair them. The
[completion-repair qualification](evidence/operator-preview-storage-completion-repair.json)
uses isolated recovery records and copied accounting metadata referencing an actual
retained read-only filesystem. It preserves the real registry, image bytes, seeded
SQLite/binary data, loop and mount; it does not claim a naturally interrupted write.

The [read-only recovery qualification](evidence/operator-preview-storage-readonly-recovery.json)
uses an unused QA filesystem with seeded data. It covers controlled mount loss,
a known live-writer refusal before effects, an unrelated running peer, explicit
reconciliation and a fresh recovery epoch. Independent reads verify unchanged
backing-image bytes, original loop and role identities, retained charges and
stable recovery records. All QA containers remain stopped and retained after the
trial. That trial reuses the existing loop. A separate
[host-restart qualification](evidence/operator-preview-storage-host-restart.json)
covers a fresh Linux ARM64 Docker engine after a graceful VM stop/start: the
kernel boot ID changes, the engine identity stays stable, and the old loop and
mount are absent before recovery. Recovery attaches a new read-only loop and
retains closed SQLite and binary fixtures, their original role inodes and the
storage charge. The restart-policy-`no` fixture container remains stopped; the
existing 149-container QA engine retains its original boot, mounts and data.

This qualifies same-engine read-only access for that restart profile. It does not
qualify power-loss/crash consistency, open database/WAL recovery, writable app
restoration or partial recovery-record repair. Public launch and default cron
admission remain closed.

For changes to the privileged admission worker, run its metadata and failure
regressions on an owned Linux test host with a source checkout:

```sh
sudo python3 packages/cli/test/preview-storage-admission-host.py --local-source
```

These tests create only their own temporary metadata directories, inject the
provisioning callback and check cross-process lock exclusion. A native helper
case allocates one new 4 KiB temporary file; the tests perform no loop-device or
mount operations. Native filesystem and lifecycle qualification
is separate.
