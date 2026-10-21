# Experimental activation on the guarded release runtime

The [sealed activation receipt](evidence/m11c-sealed-activation.json) qualifies
selected controller interruption boundaries on the signed release executable,
with read-only program files and runtime identity checks. Ordinary cron admission
remains closed. This profile drives a direct `Controller` instance through private
commands; it does not qualify the normal deployment or external admin/TLS flow.

The receipt pins the qualification sources at commit
`107bf03f3ed97f2dc78b48f90c893b6ab8d94a52`. Reproduce the recorded result from that
revision. Shared release helpers in the current tree have different fingerprints;
the receipt does not qualify those later helper changes.

## Reproduce the profile

At the pinned revision, with the local images identified in the receipt available, run the
[driver](../scripts/cron-sealed-activation.mjs) in a new private directory:

```sh
node scripts/cron-sealed-activation.mjs .fogd/NEW_SEALED_ACTIVATION
```

The fixture reserves loopback ports 8952 and 8953 and private networks
`10.252.238.0/24` through `10.252.240.0/24`. Run one instance at a time with those
resources available. The gateway serves the refresh app through workerd. The
controller service hosts an idle process; the checkpoint controller separately
owns the internal gateway lookup listener. There is no external admin listener.

Only the fixture's fresh project is started and stopped. Cleanup removes its
containers and networks while retaining all seven volumes. Artifacts, commands,
receipts, logs, controller secrets and audit archives are private material; keep
them in ignored storage. The build reuses the checked native/dependency base,
without dependency installation or Rust compilation. The root package may differ
from that base only in scripts, and the platform package only in exports; installed
manifest hashes and all dependency declarations remain checked.

## Immutable cases and execution

The image policy pins the slot, state directory, input/output locations and eight
case names. Each case binds its mode, fault point and one of three artifact digests.
The host builds those three ordinary Void fixture artifacts before image creation.
The controller checks the selected input before initialization and secret creation,
and checks the staged copy before approval. Restart must retain that same digest
and secret revision.

The two reviewed image profiles select their program files from a fixed table.
The activation image contains the idle host, checkpoint controller, policy helpers
and shared runtime helpers. Executable helper code stays in the read-only image;
application artifacts and command/result data live in the controller volume.
The layer audit checks both added COPY layers and their exact allowed paths.
Inventory and signed observations verify the images, declared launch restrictions
and four native identities before the scenarios begin.

A controller command accepts only a case name. Extra Node arguments and loader
settings are refused. Before SIGKILL, the driver checks the complete process
command line and process start time. It requires the actual `docker exec` exit
code 137. Checks between cases require only the idle host remaining and the
internal listener free, so an orphaned CLI cannot silently finish a native change.

| Cut | Required observation |
| --- | --- |
| First application publication | A minute passes before approval and another during held migration; publication completes before the controller is killed |
| First native resume | Approved callbacks can complete before the lost response is journaled; restart re-establishes the hold |
| Update after durable release | The dispatch hold is durably cleared while the active pointer still names the older approval; restart requires explicit retry |
| Paused update publication | Operator pause survives interruption and approval retry; HTTP serves the approved update while future dispatch stays held |

Every restart marks interrupted activation failed and performs only the hold
reconciliation. It must not bootstrap, migrate, publish or resume automatically.
Explicit retries use the same approval and secret revision. Both running retries
produce actual future results. Later reads recheck occurrence identities across
all recorded held intervals and confirm that earlier business results survive.
The paused update receives two later minute-boundary checks.

Native callbacks and pending `waitUntil` work are not drained by these checks.
The occurrence ledger distinguishes scheduled identities; it does not establish
callback entry times or exactly once external effects. This profile uses the
release binary's default handler budget. This profile does not qualify watchdog
termination or per-worker CPU quotas.

## Accept the evidence

Require an actual terminal exit of zero, the complete `sealed-activation.json`,
all four cut records and the final shutdown log. A printed pass or an intermediate
`interruptions.json` alone is insufficient. The controller service log belongs to
the idle host; checkpoint receipts and captured exec outcomes describe the killed
controllers. Postflight errors can appear only in the runner's stderr, so retain
that output and check it as well as failure markers.

Final postflight requires all four SIGKILL results, preserved approval and secret
pins, exactly three retained artifact digests, and a final approved paused state.
It checks removal of owned containers/networks and retention of all seven volumes.
Independent acceptance verifies native signatures, image layers and retained
artifact bytes, then checks the ledger intervals and shutdown outcomes.

The cleanup pause is a guarded native disarm command and does not update the
controller's dispatch journal. Retained state after a failed trial can therefore
need reconciliation. Qualification does not cover interruption of the host driver
or arbitrary failure during cleanup. Diagnostic trials remain failures and their
volumes are retained. Neither historical interruption evidence nor the separate
[sealed recovery profile](cron-sealed-recovery.md) transfers additional lifecycle
claims to this run. Runtime selection, the remaining lifecycle gates and normal
scoped admission remain open under the [M11c contract](m11c.md). Runtime identity
retains the [policy's lifecycle limits](cron-runtime-policy.md#qualification-still-required).
