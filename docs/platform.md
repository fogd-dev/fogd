# Platform v0 design

Use a small deployment approval controller with pre-provisioned celld fleets and
workerd hostname routing. Claude and Gemini reviewed this choice; see the [review response](reviews/platform-response.md).

## Options and estimated effort

These are engineering estimates for this prototype, not measured delivery times.
They exclude hostile multi-tenancy, billing, and public production operations.

| Option | Estimated effort | Main cost |
| --- | --- | --- |
| Patch Void Platform adapters | Several weeks | Replace Cloudflare provisioning, WfP dispatch, Hyperdrive, analytics, auth installation, and build infrastructure |
| Implement WfP on workerd dynamic loading | Several days to weeks | Build namespace storage, resource injection, version lifecycle, and limits; stateful bindings still need a bridge |
| Shared celld fleet with a generated root router | Several days | Coordinate the one fleet entrypoint across every deploy, class/resource identity, and app isolation |
| Custom deploy gate and isolated fleets | A small prototype in this implementation session | Artifact validation, approval state machine, routing, and migration/adoption gates |

The deploy gate is the smallest reversible choice that satisfies teammate
submission and admin control. It reuses the runtime behavior already tested in
milestones 2–4 and does not need Postgres, OAuth, or Cloudflare APIs.

## Container view

Compose provisions MinIO, workerd, a Node controller, and two fleet slots. Each
slot contains two celld replicas on its own private network with separate volumes.
The controller and workerd can reach both fleets; application replicas cannot
reach the other fleet directly. MinIO joins each private network. The controller
has no Docker socket or host command-execution API.

A slot is an operator-provisioned capacity unit. The controller assigns an app to
one free slot on its first approval, then persists that assignment. Slots are not
recycled automatically. The initial stack supports two apps. Operators add more
slots through Compose and the fleet configuration; the controller does not create
containers or promise elastic scheduling. Slots use fixed `slots/slot-1` and `slots/slot-2` bucket prefixes, configurable by
the operator. Conditional `fogd-owner.json` markers reserve slots permanently for
one app. Each app's resource names remain stable across releases. Each replica retains its node ID with its log volume.

This costs four celld containers for two apps, matching ADR 002. A future homelab
places one replica per slot on each machine and supplies peer addresses and an
external bucket endpoint through configuration. Local MinIO is still one failure
domain and no high-availability claim is made for the controller.

## Component view: submit, review, activate

The teammate CLI builds locally with app-local Vite, stages a validated worker,
assets, SQL, and resource metadata, then sends a bounded file manifest with a
SHA-256 digest to `POST /v1/deployments`. A bearer deploy token authorizes submission.
It cannot approve, access runtime credentials, or invoke arbitrary commands.

The controller validates paths, file counts, size, schema, and digest before
persisting immutable pending files. It validates the generated celld config again;
client-supplied claims are not authority. Rejected and pending code never reaches
`celld deploy`. Admin routes use HTTP Basic authentication. The admin page lists
app, digest, resources, and migrations, and offers approve/reject controls. Mutation
requests require JSON, same-origin checks when an Origin is supplied, an explicit digest, and a CSRF
token obtained from the authenticated admin endpoint. Both browser and CLI mutations
require this token. A CLI admin command can use the
same endpoint with explicit Basic credentials.

Approval serializes controller mutations and changes the request from pending to
activating. It verifies stored bytes against the approved digest before invoking
celld. The executable and arguments are fixed controller code, never submitted
shell commands. Runtime credentials are present only in the controller, bucket initializer, and replicas,
not in the CLI build process or uploaded artifact.

For an existing app, preserve resource identities and existing migration hashes,
pause routing durably, then run migrations against the current deployment. For a new
app, publish privately, wait for replicas, and migrate before public routing. v0
rejects background consumers, cross-app service bindings, AI, Hyperdrive, and other
capabilities whose activation cannot be safely gated by this sequence. Authentication
schema auto-migrations and importing existing Void migration ledgers remain gaps.

Verify expected celld versions on both replicas and their health before recording
the release active. The app hostname routes only an active release. Successful activation supersedes
other requests for that app, including older active releases. Retrying a superseded
request is rejected; deliberate code rollback requires a fresh submission. During an
existing-app activation, pause the route (HTTP 503) to avoid serving mixed versions;
there is no promise of zero downtime. If activation fails, keep the route paused and surface the step and error. The
admin can retry the same digest. Reconcile the applied D1 ledger against the
attempted artifact before accepting an activation: applied SQL hashes are immutable,
but unapplied failed SQL can be corrected in a new submission. An unavailable ledger
blocks activation. Never infer release adoption from an old healthy replica.

On controller restart, reconcile any activating request to a failed/paused state.
Never automatically replay migrations or approval. Pending requests remain pending,
and successfully active routes reload from durable controller metadata. Controller
metadata and bucket data require coordinated backups; losing the slot assignment
must not silently assign an existing prefix to a different app. At startup, bucket
ownership without matching local metadata quarantines the slot. Restore the original
controller volume from backup; there is no automatic state import or slot reset.

## Component view: routing and limits

workerd queries the controller's private routing endpoint using a gateway token.
It maps an exact `<app>.<base-domain>` hostname to one configured slot, checks
replica health, and forwards one request to a healthy replica. It rejects unknown
hosts and internal Void/fogd paths, strips privileged headers, and never retries an
ambiguous write. A controller outage returns 503 rather than guessing a route.

Docker limits CPU and memory per replica and per controller/ingress. celld limits
V8 heap, resident cells, and request body size. The API bounds upload size, pending
requests, and app slots. These are coarse operational limits, not Workers-for-
Platforms per-request CPU accounting. The controller must not advertise otherwise.

## Security scope and review gates

This is a platform for trusted, admin-reviewed application code. celld trusts app
code and exposes internal operator interfaces within its process/network. Approval
and separate fleet networks reduce accidental cross-app access; they do not create
a hostile tenant sandbox. The local endpoints bind to loopback. Public deployment
needs TLS, scoped storage credentials, a private encrypted peer network, and an
additional isolation design. Basic credentials must not be sent over public HTTP.

Acceptance checks cover two distinct hostnames, no route before approval, rejected
requests never executing, exact-digest approval, credential separation, malformed
artifact rejection, serialized conflicting approvals, failed activation, and
controller restart persistence. Re-run the notebook's data and recovery checks on
its assigned fleet. The original proposal and both independent reviews are preserved in `docs/reviews/`.
Run `node scripts/platform-smoke.mjs` against a fresh stack to exercise the complete
flow, including intentionally failed SQL and subsequent recovery. Unit tests inject
activation failures and controller metadata loss without modifying running fleets.
