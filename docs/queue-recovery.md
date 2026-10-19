# Recover a Docker installation with queued work

Docker backup and restore support the privately qualified single-queue app profile.
Queue admission has an [experimental Docker opt-in](queue-admission.md) and defaults off. Kubernetes and expansion refuse activated or retired queue history; never-approved
artifact-only history does not disable recovery.
Docker retirement has an explicit [stopped-work protocol](retirement.md#queued-app-retirement). This guide describes the
recovery protocol; it does not open queue admission.

## Back up

Use the same private configuration and administrator credentials as the running
installation, then run `fogd backup DIRECTORY`. Keep exclusive operator access
through the operation: do not approve, resume, or modify runtime state concurrently.
An existing output directory is refused before any delivery operation.

For each queued app, backup binds preparation to its active deployment and digest,
persists operator pause, and records the approved runtime generation, counts, and
oldest retained message. All replicas must use the controller's exact runtime image.
Every queue declaration must belong to an activated app. Interrupted activation or
unresolved earlier recovery must be addressed first.

Backup then stops all writers and archives controller metadata, bucket data, every
replica identity/log, configuration, and exact images. It checks the preparation IDs,
active artifact, route, pause, and retention bound again against stopped metadata.
It checks age once more before issuing a successful manifest. An admin action or
queue declaration racing preparation can cause refusal.

A failed preparation can leave some apps operator-paused. A failure after stopping
leaves the installation stopped and may retain incomplete output without a success
manifest. Preserve source volumes and inspect the reported failure. Do not treat
partial output as a complete backup. Successful backup also leaves the source stopped
and queues paused; restarting it does not automatically resume delivery.

## Restore and acknowledge

Run `fogd restore BUNDLE --project NEW_PROJECT --output DIRECTORY`. Keep the source
stopped. Restore requires fresh resources, matching archived evidence, and a snapshot
within its retention bound. Legacy queued bundles without evidence refuse before
image loading or target creation. The snapshot image must implement queue recovery.

Start the restored installation with the Compose command printed by restore. The
persisted runtime pause applies before the controller starts. The controller checks
pause and the approved generation again, records possible expiration or a smaller
backlog, and keeps HTTP access and delivery paused pending acknowledgment.

Inspect the exact recovery and deployment identities:

```sh
fogd admin delivery APP status
```

Reconcile unfinished jobs from their retained application input when indicated.
Then acknowledge the displayed recovery ID, review hash, and artifact explicitly:

```sh
fogd admin recover APP DEPLOYMENT_ID ARTIFACT_SHA RECOVERY_ID REVIEW_SHA --accept-possible-loss
```

If a check discovers a new finding or changes the observed backlog, acknowledgment
refuses. Inspect status again and use the new review hash. Temporary runtime
availability errors are separate from retained possible-loss findings.

The admin page also provides an acknowledgment button with a loss-acceptance prompt.
Acknowledgment restores HTTP access but leaves delivery paused. Findings and the
first successful observation remain in the recovery audit even if a later check
succeeds. Ordinary pause cannot erase them. Resume requires another explicit action:

```sh
fogd admin delivery APP resume DEPLOYMENT_ID ARTIFACT_SHA
```

If pause or the generation cannot be confirmed, restore the matching fleet and
retry. Recovery retries an unconfirmed startup pause after replicas become available.
The resulting observation changes the review hash, so inspect status before
acknowledging again. Mismatched approval, ownership, or runtime state cannot be
bypassed by approving different code: recover matching state and images first.

## Retention and delivery limits

Pause does not freeze message age. The supported build pins celld's production
retention contract; its snapshot receipt records that contract and a clock margin.
Restore checks age before starting work, but starting Compose much later can allow
messages to expire before the controller detects it. The immutable bundle remains
available. New arrivals can mask a smaller backlog, so the count comparison is not
a completion detector. This protocol reports possible expiration; it does not prevent it or
make expired messages eligible for ordinary delivery.

The supported clock assumption is that source and restore host clocks differ by
less than the recorded margin. There is no distributed clock-skew measurement.
Physical-count/backlog discrepancies refuse preparation. Messages leased to running
handlers are included in the retained metrics. Retries preserve original enqueue
time. New arrivals during observation use a conservative bound from its start.

Pause does not drain HTTP requests, queue handlers, `waitUntil`, or Durable Object
alarms. A handler can finish during shutdown; a killed handler can be delivered again
or exhaust its retry budget. An empty queue does not establish application completion.
The imports fixture retains D1 jobs and R2 input so an operator can retry unfinished
work. Exactly once external effects and automatic reconciliation are not provided.

Source: celld commit `90b43017241f81189453d326d05948f388b34652`,
[production retention](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/logic/queue.rs#L37),
[test-only overrides](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/queue_policy.rs#L393),
[retained metrics including leases](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/js/harness.js#L6310),
[retention scheduling while paused](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/js/harness.js#L6593),
and [persistent pause](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/js/harness.js#L7351).

## Qualification

On a fresh disposable M11 Docker fixture, run the controller probe from
[queue qualification](queue-qualification.md), then:

```sh
FOGD_ENV_FILE=PATH_TO_PROBE_ENV node scripts/queue-installation-recovery.mjs \
  CONTROLLER_EVIDENCE_DIRECTORY NEW_EVIDENCE_DIRECTORY fogd-m11-recovered
```

The probe adopts the privately staged app into the fixture's empty public controller,
recreates replicas on the current built runtime image, queues one pending import,
and runs the actual backup/restore commands onto fresh volumes. It starts the target with the exact printed Compose command, proves pause and
backlog persist, checks that resume is blocked, acknowledges through the CLI, then
resumes and verifies completion through the public workerd route. A separate
replica-first restore confirms pause before controller startup. Browser confirmation
and cancellation have a separate runtime-stand-in probe in
`scripts/queue-recovery-browser.mjs`. The [recorded result](evidence/m11a-queue-installation-recovery.json)
distinguishes private artifact adoption from public deployment admission.

Tests cover stale preparation, mismatched counts, interrupted routing, delayed
startup, permanent findings, ambiguous acknowledgment writes, old acknowledged
contracts, authorization, CSRF, redaction, and CLI identity/loss acceptance. An expired
checksummed bundle is rejected by the actual CLI before Docker access. These clock
boundary tests do not claim a four-day wall-clock aging experiment or power-loss test.
