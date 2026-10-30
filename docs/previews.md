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

## Execution policy and remaining work

Preparation records the intended execution policy. Enforcement and launch remain
unavailable. The lifetime is an integer from 60 to 3600 seconds, measured from a
future authorized launch rather than from download time. This initial profile
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

Public execution and launch commands remain unavailable. The remaining integration
must connect the verified artifact and decision to an admitted preview runtime,
allocate fresh resources, enforce capacity and every-service expiry,
then demonstrate a fresh app and an update. All retained deployments are QA
fixtures; fresh installation and same-family recovery are the release targets.

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
expiry and process exit do not release holds. No release operation is available;
verified teardown and reclamation remain required work.

Malformed records or interrupted writes retain the pending marker and files.
Ordinary capacity refusal releases the checking fence and preserves prior holds.
Managers must share the configured root; the fence is local exclusion, not a
distributed engine lock or protection against privileged record deletion.

The [reservation check](evidence/operator-preview-reservations.json) covers
filesystem persistence, competing processes, damaged records and retained holds.
The actual QA engine refuses fresh initialization because earlier preview networks
have no registry entries; those resources and the refusing marker remain retained.
This is refusal evidence, not a successful real-engine enrollment or launch.
