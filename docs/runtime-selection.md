# Selected Docker runtime

Runtime selection is an experimental foundation for approved scheduled apps.
The shipped catalog contains a candidate; ordinary enrollment remains closed.
A catalog entry records an immutable image and its checked programs. Qualification
of the complete [M11c contract](m11c.md) is required before its admission status can
permit a new public installation.

The [foundation receipt](evidence/m11c-selected-runtime-foundation.json) records
a local candidate run through ordinary TLS startup, scoped deployment, exact
approval, autonomous native jobs, dispatch pause and stopped backup. Its independent
audit checks source pins, timestamps, backup checksums and retained volumes. This
bounded flow does not qualify the remaining failure and recovery gates.

The [selected activation profile](cron-selected-activation.md) adds ordinary HTTPS
approval with migration hold, controller interruption, explicit original retry and
paused-update evidence on the same product image. It checks full job ledgers,
decoded artifact privacy and fresh native signatures. The remaining M11c gates
still control public catalog admission.

## Installation authority

The host CLI owns the [catalog](../packages/cli/src/runtime/catalog.json).
It verifies the Docker host architecture, cached runtime and storage images,
native executable, supervisor and complete production source inventory before
creating application containers. Selection uses cached images without a build or
pull. Arbitrary image IDs and environment settings cannot select a family.

Each selected installation has a separate policy volume. Only the controller
mounts it, read-only, at a fixed path. The policy binds the selected programs,
storage namespace and native fleet identities. Fresh installations receive unique
native identities without putting them in the shared environment file.
The controller validates this policy before constructing its guarded cron adapter.
A candidate label does not change controller execution semantics; the host catalog
controls new enrollment.

The host also reserves an installation directory before container creation.
That directory prevents an interrupted enrollment from falling back to a legacy
build when its policy volume is missing. It does not authorize a runtime. A
missing or invalid policy on an enrolled installation requires repair while the
installation remains stopped.
If initial creation fails after Docker resources appear, retain those volumes and
use a fresh project name for a new attempt. Inventory the failed project before
repair; deleting its host directory does not establish that its data is empty.
Orphaned project networks also prevent legacy fallback from another checkout.

The selected launch configuration restricts mounts, programs and environment
settings. This protects against configuration drift within the supported local
Docker topology. A privileged Docker operator can still replace programs, storage
or networks; signed runtime observations have the [documented lifecycle
limits](cron-runtime-policy.md).

## Deploy and operate

Public selection uses `fogd up --shared --runtime FAMILY` only for a qualified
catalog family. A candidate name is refused before credential or Docker changes.
There is no public candidate enrollment flag. Internal qualification can enroll
only a known catalog candidate, with all image and topology checks retained.

Enrollment creates stopped services and installs the independent policy. A shared
installation needs a valid TLS keypair before startup. After enrollment, ordinary
`fogd tls import CERT KEY` and `fogd up --shared` resolve the installed policy and
use its pinned image without building. Startup reports the family, current catalog
admission status and storage identity digest. Record that digest separately from
backups for future independent recovery checks.

Deployment negotiates capabilities before building. Scheduled submissions require
an app-scoped deploy token and an enabled controller; team-wide tokens cannot
submit them. The server revalidates the uploaded artifact. Upload remains inert
until exact artifact approval and the required secret revision pass admission.
Existing dispatch pause/resume controls retain their guarded native checks.

## Selected recovery

Selected restore and retirement require both `--runtime FAMILY` and
`--expected-identity SHA256`. The public commands accept qualified catalog entries
only; the current candidate remains refused. Record the identity printed by `up`
or backup separately from the snapshot. A hash supplied by a snapshot cannot
establish independent identity. Keep using trusted operator-created backups:
this digest binds storage and native identities, not every byte in the archive.

The selector requires the source's sealed launch configuration, complete immutable
image inventory and separately expected identity to match. It verifies the cached
catalog programs before image-provided helpers. Selected recovery skips the image
archive, so it cannot replace cached image tags. Network placement comes from the
independent target selection; omitted placement uses ordinary bridge allocation.
Snapshot subnets cannot select target placement. Internal qualification can choose
separate private subnets without changing logical storage identity.

Stopped backup inventories every managed volume, including the policy volume,
but archives application and operator data only. Restore copies those archives,
writes held recovery state and installs the independent policy separately. The
policy volume is never populated from a snapshot archive. Retirement first checks
the source identity, then permits only the retired fleet's namespace and native
IDs to change. Survivor and storage identities stay equal. Operation evidence
records the source and target digests; the new target digest is printed for the
operator to retain independently.

An enrolled name and an existing output directory refuse recovery. Selected
recovery reserves private host configuration before creating stopped containers.
The host-state filesystem must support hard links and directory fsync for atomic
source-record publication. A pending restoration marker prevents startup, TLS import and backup until the
complete data, policy and output records have been checked and durably finalized.
Failures retain their marker, configuration and volumes. Use a fresh project and
output for another attempt; removing the fence does not prove the data is empty.
The same rule applies to a failed first enrollment, including an explicit retry.

Start a successfully recovered installation through its canonical host state:

```sh
fogd up --installation PROJECT
```

This command requires an existing independent policy, validates the catalog again,
and starts pinned images without credential bootstrapping, building or pulling.
It cannot be combined with `--runtime` or `--shared`. Retain the source operator
environment for subsequent admin/deploy endpoints, credentials and TLS trust.
Restored scheduled work requires recovery acknowledgment and a separate explicit
resume. A late initial runtime check can change recovery findings: inspect the new
status and acknowledge its current review digest rather than replaying an old one.

Local source project and volume writers must be stopped before selected recovery
and finalization. Host recovery metadata also checks related sources, descendants and sibling
restores before subsequent selected operations. Keep using the same `FOGD_HOME`
and its private installation state for these checks; they do not inventory other
checkouts or remote hosts. These are local observations, not an atomic writer fence.
The operator must keep source copies on every host stopped and prevent concurrent
starts. The output reports the ingress bind and TLS mode for review; the storage
identity does not authenticate those exposure settings.

The [selected recovery receipt](evidence/m11c-selected-runtime-recovery.json)
covers a previously paused schedule through ordinary installed startup, reviewed
acknowledgment, separate resume and autonomous future jobs. Armed-timer, pending
retry and older-snapshot restore remain unqualified on this product image. The
[selected retirement receipt](evidence/m11c-selected-runtime-retirement.json)
covers zero-live backup/restore, unchanged retained-prefix contents and a scoped
replacement using the fresh slot. Active cron/queue survivor and pending-retry
retirement remain unqualified on this image.

Full frozen-runtime acceptance and promotion to a qualified catalog entry remain
[M11c gates](m11c.md). Expansion and other topologies remain refused for scheduled
history.

## Cached build provenance

The [runtime builder](../scripts/build-selected-runtime.mjs) assembles production
sources onto a separately pinned, clean dependency image. It performs two uncached,
network-disabled builds, requires equal image IDs, verifies source and native
program inventories and checks that source inputs did not change during assembly.
The resulting image excludes qualification programs and tests.

The clean dependency image is a cached input produced by a one-time cleanup of an
existing native/dependency image. That cleanup is not claimed reproducible from
its earlier seed. Product assembly reproducibility applies to the exact recorded
clean input; it does not establish a native rebuild, dependency installation,
registry distribution or cross-architecture support.
