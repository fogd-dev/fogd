# Experimental scheduled-runtime preboot

Normal CLI restore and retirement refuse all scheduled history before Docker
access or target creation. A snapshot, capability marker or environment variable
cannot authorize a runtime. Ordinary cron admission remains closed. Historical
cron recovery receipts apply to their pinned sources, not this guarded path.

The internal restore adapter accepts a separately supplied qualification policy.
The [app-free native receipt](evidence/m11c-runtime-preboot.json) checks program
identity and read-only startup. The separate [sealed recovery profile](cron-sealed-recovery.md)
qualifies scheduled-app backup and stopped recovery on that layout. The complete
runtime lifecycle remains an admission gate. The [selected Docker runtime
foundation](runtime-selection.md) adds a host catalog, an independent policy
volume and normal startup/TLS integration; its catalog candidate remains closed
to ordinary enrollment.

## Independent launch policy

A trusted qualification caller supplies the policy directly to
[`restoreInstallation`](../packages/cli/src/recovery/restore.mjs). There is no CLI
flag or environment setting for it. The policy is copied before archive reads.
The [native fixture](../scripts/cron-probe/preboot/fixture.mjs) shows its construction
from independently checked local images and an explicit topology.

The policy binds runtime and storage image IDs, native executable and supervisor
digests, controller launch arguments, bucket/origin/region and every fleet/node
identity. Optional network subnets require a complete, distinct set of private
10/8 `/24` networks matching the configuration exactly. Otherwise only ordinary
Docker bridge addressing is accepted. This local restore adapter still requires
two application fleets when scheduled history exists.

The [configuration gate](../packages/cli/src/runtime/cron-preboot.mjs) checks the
existing recovery topology, then restricts Compose declarations, mounts, commands
and environment variables. Named volumes cannot introduce drivers or host bind
mounts. Includes, configs, secrets, alternate service loaders and custom temporary
mounts are refused. Inert `x-` metadata is removed. Per-role environment allowlists
cover the controller, gateway, initializer, storage server and native nodes.
Storage credentials must agree across the relevant services.

Every service uses its checked immutable image, no build instruction and no image
pull. Program files are read-only; normal data volumes remain writable, TLS stays
read-only, and `/tmp` is a private writable, non-executable tmpfs. All capabilities
are dropped and no-new-privileges is enabled. Native nodes use the explicit
supervisor path, standalone storage, canonical state directory and private identity
listener. Node-based services and MinIO receive explicit interpreter/program paths.

## Verification before application containers

After loading the archived images, the [image verifier](../packages/cli/src/runtime/cron-image.mjs)
checks the expected image ID and its inherited startup settings. Runtime image-declared volumes, active healthchecks, loader environment,
unsupported users/working directories and writable search paths fail. The storage
image permits only its explicitly mounted `/data` volume and a system search path;
inherited account or loader settings fail. An isolated Node helper checks native and supervisor bytes,
refuses program symlinks and checks that the supervisor's `node` and `celld` PATH lookups resolve to
the checked executables.

The helper mounts no application volumes, uses no network and has bounded memory,
CPU, process count and command time. It does not start celld. Failed verification
prevents `compose create` and data restoration. Archived images can be loaded
before refusal, but the output directory is created only after successful checks. Capability checks use the selected target
controller image; only then can the existing stopped-volume restore proceed.
Errors omit private configuration and remote diagnostics. The immutable image ID
covers the remaining program bytes, including Node, sleep, workerd and MinIO; only
the native executable and supervisor receive separate file-digest checks.

## Evidence and remaining gates

The native probe starts an empty installation without published ports. It rejects
six real image variants: another executable, a symlinked executable, a PATH
shadow, an image volume, loader environment and an active healthcheck. Four native identities, controller
administration, gateway health and successful bucket initialization establish the
app-free positive case. Inspected mounts match the named volumes and temporary
filesystem. Real program-directory writes fail with `EROFS`; temporary files are
writable but execution fails with `EACCES`. Source hashes are captured before the
run and checked afterward. Cleanup retains all owned volumes. Local base and mutant image tags are retained
as diagnostic artifacts.

With the receipt's local images available, use a new private directory:

```sh
node scripts/cron-runtime-preboot.mjs .fogd/NEW_PREBOOT_EVIDENCE
```

The [sealed scheduled recovery drill](cron-sealed-recovery.md) covers an armed timer,
a pending retry, a queued survivor and an older snapshot on this release binary.
Backup inventory verifies the declared temporary filesystem and named-volume
permissions. Already-sealed Node commands must match the same launch policy when
restored again. A qualified-runtime registry, normal scoped admission, the remaining
release-runtime lifecycle and general startup/runtime ownership checks remain open.
The host gate does not inspect native cells for schedules hidden by inconsistent
controller metadata: coherent, trusted stopped snapshots remain an assumption.
It does not prevent a privileged Docker operator from replacing a container or
changing a network. Signed observations remain subject to the
[runtime policy's lifecycle limits](cron-runtime-policy.md).
