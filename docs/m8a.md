# M8a: stopped installation backup and restore

Qualify recovery of the supported local Docker installation onto fresh volumes.
This slice precedes shared identities, TLS/access policy, and quotas in M8b. It does
not establish live backup, global availability, Kubernetes recovery, or upgrades
between different celld versions.

## Contract

`fogd backup DIRECTORY` captures one complete stopped installation. The directory
must not exist; create it owner-only. Resolve the actual Compose configuration and
container image IDs without printing credentials. Require the supported local MinIO
and named-volume topology; refuse external buckets, bind mounts, external volumes,
and missing or foreign project resources. Record source project, creation time,
format version, exact image identities, volume identities, and checksums.

Stop ingress and the controller first, then every replica, then MinIO. Verify no
project container is running before copying. Capture the bucket, controller, and all
replica volumes plus the resolved configuration and exact images. Preserve file
ownership and modes. Persist a completion manifest only after every archive and
image export succeeds. Incomplete output is never restorable. Leave the source
stopped on success and failure; restarting is an explicit operator action.

This is a maintenance operation under exclusive operator control. A route pause does
not drain all writers. Stop every runtime before copying; preserve all local logs
alongside the bucket. A killed replica is a crash-consistency condition that must be
reported and tested, not described as a clean database checkpoint. No external
writers, arbitrary Docker processes mounting these volumes, or concurrent operator
start/upgrade commands are supported.

`fogd restore DIRECTORY --project NAME --output DIRECTORY` verifies the completed
bundle and all checksums before effects. Require a new output directory and a fresh
Compose project with no existing containers, volumes, or networks. Load the recorded
images, generate a private resolved Compose file with fresh resource names and pinned
image IDs, create empty volumes, then restore each archive. Never start a partially
restored installation. Write a completion receipt last. A failed restore leaves its
new resources stopped for inspection; it must not overwrite or reuse them on retry.

The operator starts the generated Compose file explicitly after successful restore.
Preserve app names, hostnames, bucket prefixes, replica IDs, controller metadata,
credentials, secret revision history, artifact bytes, and migration ledgers. Source
and restored installations must not write to the same bucket. Generated configuration
must retain literal dollar signs without a second environment interpolation.

The private bundle contains plaintext credentials and application data. It is a
trusted operator artifact, not an untrusted import format or encrypted vault. Store
it on access-controlled storage; offsite encryption is an operator responsibility.
Checksums detect corruption, not malicious replacement of the entire bundle.

## Acceptance

Restore accounts and notebook onto fresh volumes, retaining native account login,
sessions/signing secrets, D1 rows, R2 bytes, Durable Object state, approval history,
and subsequent writes/deployments. Record snapshot duration, restore duration, and
loss boundary. All acknowledged writes before the stopped snapshot should survive;
changes after source restart are outside that snapshot.

Corrupt and incomplete bundles must fail before creating target resources. Refuse
occupied targets and unsupported topology. Exercise interrupted activation/recovery,
retry refusal for partial restoration, and continued writes after restore. Pin the
same images for recovery; version upgrades need separate evidence. Review the design
and implementation with Claude and Gemini, record amendments, and update the report.
