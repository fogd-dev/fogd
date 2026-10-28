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

Before enrollment, inspect the selected Docker engine without starting containers
or changing host configuration:

```sh
node packages/cli/bin/fogd.js doctor --runtime celld-cron-v2-linux-arm64
node packages/cli/bin/fogd.js doctor --runtime celld-cron-v2-linux-arm64 --json
```

This host metadata check reports Docker access, runtime architecture,
offline-transfer image-store qualification, Compose availability, and exact cached
image IDs and platforms. `supported` applies only to the named check. It does not
verify image programs or source bytes, installation ports/subnets, backing storage,
TLS, or application compatibility. These appear as `unverified` findings with
next steps. Startup and deployment retain their authoritative checks.

The command exits with code `1` when an observed condition is unsupported and `2`
when readiness remains unverified. This metadata-only scope never reports full
installation readiness or exit code `0`. A failed image inspection cannot
distinguish a missing image from access failure. Diagnostics exclude raw Docker
output and private host configuration. The selected Docker context is inherited;
no context is switched, image pulled, resource created, or capacity reserved.
Candidate families can be diagnosed but remain closed to ordinary enrollment.
For application declarations, use the separate
[JSON configuration check](developer-client.md#check-json-declarations-without-building).
The operator CLI and standalone developer client both provide that check.

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

Fresh enrollment accepts `--network-plan FILE` with the same bounded private-subnet
format used by selected recovery below. It checks overlap against existing Docker
subnets before reserving enrollment. Installed startup accepts only its original
plan; it cannot move networks. `up --installation PROJECT` uses the saved placement
without reading a plan. See the [operator guide](operator-guide.md#choose-private-subnets-when-needed).

Enrollment creates stopped services and installs the independent policy. A shared
installation needs a valid TLS keypair before startup. On a fresh installation, the first enrollment command reports an installed TLS
keypair error after creating stopped services. Import the keypair, then start the
enrolled project:

```sh
fogd tls import CERT KEY --installation PROJECT
fogd up --installation PROJECT
```

Use a fresh Compose project and retain its operator environment, as described in
[shared installation](shared-installation.md). Existing data cannot be adopted by
fresh enrollment. These commands resolve the installed policy and use pinned images
without building. Startup reports the family, current catalog
admission status and storage identity digest. Record that digest separately from
backups for future independent recovery checks.

Use the project name from the operator file in place of `PROJECT`. Explicit
`backup DIRECTORY --installation PROJECT` and `tls import CERT KEY --installation PROJECT`
read that project's canonical host configuration and refuse missing retained
storage. They do not fall back to the profile's original project after recovery.
Keep the matching admin endpoint and TLS trust selected for background controls.

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
Selected startup also requires every configured volume to exist with its original
local Compose project/role ownership. Missing or foreign storage refuses before
installation service creation; use stopped recovery rather than empty replacement
volumes. Read-only catalog and policy checks can run helper containers first.
It cannot be combined with `--runtime` or `--shared`. Retain the source operator
environment for subsequent admin/deploy endpoints, credentials and TLS trust.
Restored scheduled work requires recovery acknowledgment and a separate explicit
resume. A late initial runtime check can change recovery findings: inspect the new
status and acknowledge its current review digest rather than replaying an old one.

Use `fogd stop --installation PROJECT` for an ordered stop without a snapshot.
It retains the saved configuration and storage, preserves restoration fences and
does not change persistent background pause controls. See
[operator maintenance](operator-guide.md#stop-and-resume-maintenance) for scope.

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

## Prepare the next native source

Maintainers can prepare the next native source tree from existing local Git
objects without an image build or dependency installation. This requires Node.js
and Git with `--no-lazy-fetch`; missing local objects refuse instead of fetching:

```sh
node scripts/runtime-source.mjs /path/to/celld /tmp/fogd-native-source
```

Use a new output directory whose parent exists, outside both input repositories.
The command selects the upstream commit, dependency
lock and ordered patch hashes declared in
[`docker/runtime-source.json`](../docker/runtime-source.json). Local checkout
edits do not enter the prepared tree. Existing output is refused; a failed attempt
retains its partial directory for inspection and needs a different output path.
The output contains `source/` and a `receipt.json` recording the resulting source
inventory. A failed attempt has no completion receipt. The receipt describes source
preparation only; it does not establish compilation, native test execution or a
qualified runtime.

This is the source-preparation step of the
[next runtime release](operator-readiness.md#next-runtime-release). A clean native build, observed output
fingerprints and qualification remain required. The cached builder above still
uses its recorded private dependency input. Preparing source does not change the
catalog or authorize installation of a new runtime family.

## Prepare a runtime build context

Maintainers can assemble the candidate runtime's build inputs without invoking
Docker or installing dependencies:

```sh
node scripts/runtime-build-context.mjs /tmp/fogd-native-source \
  docker/runtime-build-inputs.json /tmp/fogd-runtime-build
```

The first directory comes from source preparation above. The
[build-input file](../docker/runtime-build-inputs.json) pins the Linux arm64 Rust
and Node base manifests. The command refuses mutable image references and other
platforms. Use a new output directory with an existing parent, outside the source
and fogd repositories. Existing output is never reused.

The output's `context/` contains the reverified native tree, production platform
and runtime programs, dependency locks, supervisor and rendered
[Dockerfile](../docker/runtime-source.Dockerfile). The fogd package copies contain
only manifests and production sources. Checkout secrets, application data and
installed workspace dependencies are excluded. The completion
receipt binds the selected image references and the captured context inventory.
File modification times and directory permissions are normalized for assembly.
Keep partial output after a failure for inspection and use a different directory
for another attempt.

The candidate recipe compiles celld against a declared prebuilt Rusty V8 library
and runs the upstream Cargo test and clippy stages. The
[native-input manifest](../docker/runtime-native-inputs.json) pins the archive and
bindings by SHA-256 and byte length, and ties their release to the V8 crate in
`Cargo.lock`. The pins come from the
[upstream release asset metadata](https://api.github.com/repos/denoland/rusty_v8/releases/tags/v152.1.0);
the bindings also match the file embedded in the locked crate. During image
assembly, the standalone acquisition helper verifies both assets before publishing
its receipt. It bounds requests and streams, refuses unapproved redirect hosts,
and retains partial output privately on failure. Rust uses explicit local paths
for both inputs. Source context preparation performs no downloads.

The recipe installs pnpm through its
[integrity lock](../docker/runtime-tools/package-lock.json) and runtime dependencies
through the frozen workspace lock with lifecycle scripts disabled. The
[workerd placement helper](../docker/runtime-workerd.mjs) selects the locked Linux
arm64 package, checks its metadata and ELF header, and copies its executable into
the gateway path without running an installer or fetching a fallback. It records
the copied binary fingerprint. The recipe uses no private seed image or build-cache
mount. An upstream test stage can execute zero public cases; successful image
assembly would still need separate native lifecycle qualification.

Source context preparation does not establish a successful clean-host build,
native behavior, output fingerprints or independent installation. Those remain
[next-release requirements](operator-readiness.md#next-runtime-release), and a
built candidate still needs its own family identity and qualification before
catalog admission. The existing cached family's image and installation authority
are unchanged.


## Build a source candidate

Maintainers can explicitly build the prepared source and record its output:

```sh
node scripts/build-source-runtime.mjs /path/to/celld /tmp/fogd-source-build
```

This command downloads build dependencies and compiles native code. It requires
existing local objects for the pinned upstream revision and a Linux arm64 Docker
engine. The selected Docker context must use the Docker build driver. Use a new
output directory with an existing parent, outside both source repositories.

The [build command](../scripts/build-source-runtime.mjs) prepares fresh native
source and a captured build context, then requests one uncached build using the
pinned base images. It binds the build and subsequent inspections to the selected
Docker context. Private stdout and stderr files share a byte limit and deadline;
the command retains the attempt outcome and partial output after failure. A failed
or interrupted Docker client does not prove that the daemon stopped its build.
Inspect that builder before another attempt; the command never retries or prunes
images automatically.

A successful `result.json` records the image ID, declared source and base-image
inputs, native and supervisor fingerprints, gateway fingerprint, production
program inventory, dependency receipts and toolchain output. The reader runs with
networking disabled, a read-only filesystem and no application mounts; it reads
native headers and hashes without executing the binaries. The image build itself
includes the recipe's native version, test and lint stages. Changed build contexts,
unexpected image configuration or mismatched outputs withhold the completion
record. Logs and records remain owner-private.

A completed build is a candidate. It does not establish an independently observed
clean build host, repeatable image digests, lifecycle behavior or installation on
another engine. The command neither publishes an image nor changes the catalog or
installation admission. Follow the
[next-release requirements](operator-readiness.md#next-runtime-release) before
qualifying a new runtime family. The command has process/filesystem tests with a
substituted Docker executable. The [native build evidence](evidence/operator-source-build.json)
records an uncached build on a fresh isolated Docker engine, passing native tests
and strict lint, checked image fingerprints and direct cron help output. The engine
shares its physical host with earlier qualification; independent installation and
application lifecycle acceptance remain open.
