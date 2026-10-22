# Selected Docker runtime

The `celld-cron-v2-linux-arm64` family qualifies approved scheduled apps on local
Linux arm64 Docker with two application fleets. The [acceptance audit](m11c-acceptance.md)
records its exact scope. Default installations and unqualified families retain
closed cron admission.

The CLI requires the exact cached runtime and storage images listed in the
[catalog](../packages/cli/src/runtime/catalog.json). It does not build or pull a
replacement when those images are missing. Runtime distribution and the cached
build's provenance limits are described below.

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

Set explicit private storage credentials as described in the
[shared installation guide](shared-installation.md) before enrollment.
Public selection uses `fogd up --shared --runtime FAMILY` only for a qualified
catalog family. A candidate name is refused before credential or Docker changes.
There is no public candidate enrollment flag. Internal qualification uses known catalog families without promoting an
unqualified entry; all image and topology checks remain in force.

Enroll a fresh Compose project with the cached family:

```sh
fogd up --shared --runtime celld-cron-v2-linux-arm64
```

Enrollment creates stopped services and installs the independent policy. A shared
installation needs a valid TLS keypair before startup. On a fresh installation, the first enrollment command reports an installed TLS
keypair error after creating stopped services. Import the keypair, then repeat the
public start command:

```sh
fogd tls import CERT KEY
fogd up --shared --runtime celld-cron-v2-linux-arm64
```

Use a fresh Compose project and retain its operator environment, as described in
[shared installation](shared-installation.md). Existing data cannot be adopted by
fresh enrollment. These commands resolve the installed policy and use pinned images
without building. Startup reports the family, current catalog
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
only; candidate families remain refused. Record the identity printed by `up`
or backup separately from the snapshot. A hash supplied by a snapshot cannot
establish independent identity. Keep using trusted operator-created backups:
this digest binds storage and native identities, not every byte in the archive.

The selector requires the source's sealed launch configuration, complete immutable
image inventory and separately expected identity to match. It verifies the cached
catalog programs before image-provided helpers. Selected recovery skips the image
archive, so it cannot replace cached image tags. Network placement comes from the
independent target selection; omitted placement uses ordinary bridge allocation.
Snapshot subnets cannot select target placement. Use `--network-plan FILE` with
either selected recovery command to choose separate private subnets without
changing logical storage identity. The operator-supplied file must be a regular
JSON file of at most 4096 bytes with exactly three distinct `10.x.x.0/24` subnets:

```json
{
  "control": "10.253.180.0/24",
  "fleet-1": "10.253.181.0/24",
  "fleet-2": "10.253.182.0/24"
}
```

Choose subnets that do not overlap existing networks or host routes; the example
does not establish that these addresses are free on your host. For example:

```sh
fogd restore BUNDLE --project NEW --output DIR \
  --runtime FAMILY --expected-identity SHA256 --network-plan networks.json
```

Family admission and expected-identity syntax are checked before reading this
file. Its contents select network placement only; they cannot select a runtime
image or authorize a different source identity. Candidate catalog entries still refuse ordinary recovery, including when a network
plan is supplied.

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
and finalization. Host recovery metadata also checks related sources, descendants,
and sibling restores before startup, TLS import, and backup. The check includes
running writers on each related installation's volumes, even under another project
label. It reads current names from any enrolled peer's private configuration; an
unreadable related configuration refuses the operation. A stopped incomplete peer
can supply volume names for exclusion without being authorized to start.
Keep using the same `FOGD_HOME` and its private installation state for these checks;
they do not inventory other checkouts or remote hosts. These are local observations,
not an atomic writer fence.
The operator must keep source copies on every host stopped and prevent concurrent
starts. The output reports the ingress bind and TLS mode for review; the storage
identity does not authenticate those exposure settings.

The [acceptance audit](m11c-acceptance.md) identifies the selected activation,
replacement, failure, recovery, retirement, and public-selector evidence. Public
selection was qualified using the same image and source pins as the lifecycle
profiles. Expansion and other topologies remain refused for scheduled history.

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
