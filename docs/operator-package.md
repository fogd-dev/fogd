# Operator package contents

An exported runtime bundle contains the qualified runtime and storage images,
matching operator program, Compose template, public environment example, and
selected operating instructions. After authenticated import, start with
[Run your application cloud](operator-guide.md). Keep the independently retained
transfer hashes and matching package alongside your recovery material.

## Included instructions

| Task | Guide |
| --- | --- |
| Authenticate, transfer and import software | [Offline installation](offline-installation.md) |
| Install, approve, diagnose, stop and recover | [Operator workflow](operator-guide.md) |
| Select the qualified family and recover its identity | [Runtime selection](runtime-selection.md) |
| Configure shared credentials and HTTPS | [Shared installation](shared-installation.md) |
| Export a developer client | [Developer client](developer-client.md) |
| Compare proposed and active artifacts | [Artifact review](artifact-review.md) |
| Inspect recorded application state | [Application inspection](application-inspection.md) |
| Observe native replicas locally | [Application observation](application-observation.md) |
| Request an explicit application path | [Gateway request check](application-check.md) |
| Diagnose a submitter's release | [Submission status](submission-status.md) |
| Inspect backing filesystem space | [Storage space](storage-space.md) |
| Retain and prune local build copies | [Build retention](build-retention.md) |
| Back up and restore stopped storage | [Recovery](recovery.md) |
| Issue and revoke deployment credentials | [Deploy access](deploy-access.md) |
| Control queue delivery and recover held work | [Delivery controls](delivery-controls.md), [queue recovery](queue-recovery.md) |
| Control scheduled dispatch and recover held work | [Cron controls](cron-controls.md), [cron recovery](cron-recovery.md), [selected pause](cron-selected-pause.md), [selected recovery](cron-selected-recovery.md) |

These are the source guide bytes from the exporting operator program. They are
listed and hashed with the executable files; changing or removing one after export
fails bundle verification. Import copies them into the operator directory's `docs/`
folder. Earlier version-1 bundles may contain only the offline installation page;
the verifier still accepts that inventory when its retained manifest matches.

## Using an imported program

From the imported operator directory, invoke commands with
`node packages/cli/bin/fogd.js`. The installation, access and recovery guides use
that entrypoint. Sections labelled as legacy or checkout-only describe separate
procedures and source-based qualification scripts. Use the operator workflow's
selected installation commands for this package.

The package includes operating guides rather than the complete repository.
Links to specifications, historical reviews, evidence receipts, examples and
qualification scripts refer to the source checkout and may be absent here. The
package does not contain application SDK dependencies, credentials, installation
enrollment, backups, application data or test harnesses. Developers supply their
prepared application project and dependencies. Software transfer does not migrate
data, qualify a second machine, or change default background admission.
