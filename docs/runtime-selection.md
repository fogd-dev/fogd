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

## Recovery boundary

Stopped backup inventories every managed volume, including the policy volume,
but archives application and operator data only. Restoring a snapshot cannot
supply runtime authority through an archived policy. The internal recovery adapter
requires an independently selected policy, imports it separately and leaves
services stopped. Explicit target network placement can differ from the source
without changing logical storage identity.

Public scheduled restore and retirement remain refused, including zero-live
scheduled history. Independent public runtime selection and expected-identity
checks for those commands, followed by the complete frozen-runtime acceptance
profiles, remain M11c work.

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
