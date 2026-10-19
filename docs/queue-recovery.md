# Queue recovery qualification

Queued installations cannot use fogd's stopped backup, restore, expansion, or
retirement commands yet. Queue admission remains closed. This restriction applies
to Docker and experimental Kubernetes recovery, including snapshots that contain
only pending or rejected queue artifacts.

## Refusal behavior

Backup first reads live controller metadata and refuses known queue history before
stopping the installation or creating output. It checks the archived metadata again
after stopping all writers, so a queue submission racing the first check also
refuses. This second refusal leaves the source stopped and retains its volumes and
partial output without a successful snapshot manifest. The partial output is not a
complete backup. A failed backup does not change queue delivery
intent. Restarting the source can therefore resume previously running delivery.

Restore inspects controller metadata before loading images or creating target
resources. Docker expansion and retirement check the source metadata as well.
There is no override flag. Missing or unreadable state also fails the check, including an installation whose
controller never initialized its state file. Unknown capabilities refuse. Archives
with duplicate or ambiguous root state entries refuse.
Docker recovery requires the controller's standard data directory; a nested
`FOGD_DATA_DIR` cannot substitute unrelated metadata at the volume root. Kubernetes
recovery rejects `envFrom` to prevent indirect environment overrides.

Preserve source volumes and any previous complete snapshots after a refusal. Do
not edit out queue requirements, delivery journals, or resources to bypass it.
The permanent queue capability records history that may still matter to runtime
state even when the controller has no active queue app.

This boundary covers managed controller state. Direct celld deployments and raw
queue mutation outside fogd's controller remain outside the recovery contract.
The private runtime probes in [queue qualification](queue-qualification.md) do
not establish support for public installation recovery.

## Why pause is insufficient

In the pinned celld source, queue metrics omit expired messages at the retention
boundary, while the operator's stored count separately reports physical records.
The queue alarm scheduler still schedules retention sweeps when delivery is
paused. A snapshot can therefore contain records that expire before it is
restored, or between restore and the operator starting the replicas.

Sources: celld commit `90b43017241f81189453d326d05948f388b34652`,
[`_metrics` and `_rearm`](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/js/harness.js#L6441),
[`_setPaused`](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/js/harness.js#L7351),
and [operator info](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/js/harness.js#L7475).

The next recovery protocol needs to qualify persisted pause before snapshot,
retention handling at actual replica startup, explicit delivery resumption, and
application reconciliation when messages have expired. It must account for running
handlers and alarms; a pause is not a drain. See the
[review proposal](reviews/m11a-recovery-guard-brief.md) for the open design and
[roadmap](roadmap.md) for the remaining admission gates.

## Evidence scope

Automated tests exercise checksummed queue bundles through Docker restore,
expansion, retirement, and Kubernetes restore. They cover queue history without
an active app, unreadable metadata, and alternate data paths. The guard also
accepted the archived controller metadata from existing M8a, M10c, and M9b
qualification snapshots; their [archive fingerprints](evidence/m11a-recovery-guard-existing-snapshots.json)
identify those inputs. This is an offline metadata check, not a repeated full
restore or a queued backup/restore qualification.

The [Docker negative probe](../scripts/queue-recovery-guard.mjs), run against the
disposable M11 fixture, injects a synthetic permanent queue capability while the
controller is stopped. It verifies backup preflight refuses without changing any
container states or creating output, then restores the original metadata and
restarts that controller. [Recorded result](evidence/m11a-recovery-guard-docker.json).
This does not test an actual queued backup or the post-stop submission race.

The [review response](reviews/m11a-recovery-guard-response.md) narrows the next
protocol to explicit age checks and delayed-start detection. A permanent replica
startup deadline is no longer the proposed direction.
