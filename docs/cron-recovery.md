# Experimental stopped recovery for scheduled apps

Cron installation recovery uses a native persisted hold and a full stopped Docker
archive. The [native evidence](evidence/m11c-cron-recovery.json) qualifies
same-version recovery on local Linux arm64 Docker with two application fleets.
Ordinary cron admission remains closed: the [M11c contract](m11c.md) also requires
scoped admission, retirement and release-bound runtime qualification.

## Recovery contract

Backup inventories every background app before making a pause request. Queue and
cron apps can occupy separate fleets in the same installation. Every controller
and replica uses the same pinned runtime image. A preparation receipt binds the
active deployment, digest, secret revision, cron expressions, approved runtime
version and native hold revision. Preparation also checks each replica and its
resident cron generation. The stopped controller archive must still carry the
same receipt after every writer has stopped.

Cron pause clears the pending timer and retry identity. It does not retain a queue
of missed occurrences or drain a running callback. Resume schedules future work.
Physical recovery preserves the state in the stopped archive; it can lose newer
acknowledged results and can replay external effects. Application idempotency and
reconciliation remain necessary. Queue retention has its own independent bound;
a cron hold does not extend it.

Restore checks the complete evidence and image inventory before creating target
resources. Fresh target volumes preserve the application namespace, replica
identities, data and private configuration. New recovery IDs keep routing and
scheduled dispatch paused. The controller checks that native dispatch was already
held at the prepared revision before attempting reconciliation. An active timer or
mismatched revision permanently disqualifies that restore.

Inspect and accept the current findings after reconciling application records:

```sh
fogd admin dispatch refresh status
fogd admin dispatch refresh recover DEPLOYMENT_ID ARTIFACT_SHA256 RECOVERY_ID REVIEW_SHA256 --accept-possible-loss
fogd admin dispatch refresh resume DEPLOYMENT_ID ARTIFACT_SHA256
```

Acknowledgment restores HTTP routing and leaves scheduled dispatch paused. The
separate resume requires the same active approval. A surviving queue app has its
own [acknowledgment and delivery controls](queue-recovery.md). Missing or changed
preparation evidence is refused. Expansion, Kubernetes recovery and retirement
continue to refuse scheduled history.

## Native qualification

The [qualification driver](../scripts/cron-recovery.mjs) uses an internally staged
native Void refresh app and an ordinary CLI-submitted imports app. Its private
controller supplies the experimental cron transport to the same startup function
as the normal controller. The data directory remains `/var/lib/fogd`; the helper
and its staging result travel inside the controller archive. Restored startup
cannot stage another approval from the archived command.

The driver creates a new project with rotated credentials from an explicit local
M11c Compose template. It pins the selected image ID and keeps ports 8919 and 8920
on loopback. Three private networks use `10.252.225.0/24` through `10.252.227.0/24`. Each source is taken
down before its restored target starts, retaining all volumes. Use unused ports
and networks and a new output directory under this checkout's ignored `.fogd`.
The template and recovery bundles contain private material.

Build a runtime with the [qualified native control candidate](patches/celld-cron-controls.md),
then run the driver with the resolved JSON template:

```sh
docker build -f docker/runtime.Dockerfile \
  --build-arg CELLD_IMAGE=fogd-celld:cron-controls-candidate5 \
  -t fogd-runtime:cron-recovery-candidate5 .
node scripts/cron-recovery.mjs PRIVATE_TEMPLATE_COMPOSE_JSON \
  .fogd/NEW_RECOVERY_EVIDENCE fogd-runtime:cron-recovery-candidate5
```

The driver requires the recorded native binary hash and exact controller/runtime
source files in the image. It fingerprints host CLI code, probe helpers, both
application sources and build inputs, then checks they remain unchanged through
completion. It records the base commit and dirty worktree state.

| Case | Required observation |
| --- | --- |
| A: armed due timer | Snapshot confirms pause before the selected future alarm; fresh replicas retain the data and hold |
| B: failed native occurrence | A persisted retry deadline is observed before snapshot; the retry identity is cleared while failed-attempt records and queued input remain |
| Older A | Later acknowledged imports and cron results disappear; both apps receive new recovery IDs and require explicit loss acceptance |

Each restore starts native replicas before the controller or gateway. D1 reads
and direct bucket observations run for at least 62 VM seconds without sending
a cron-control command. The application data must match the snapshot. Native status must then
confirm a persisted hold, matching revision and no alarm or wake entry.

Controller initialization and acknowledgment receive their own data/control
checks, followed by another 62-second held interval with the controller and gateway
running. Paused app routes must return the specific activation-pause response;
resume must fail for the recorded recovery state. Every separate cron resume has
a VM-clock boundary. The driver rejects new attempts, results or counter changes
for any occurrence earlier than that boundary, including the latest missed tick.

Before accepting a run, inspect its actual terminal exit code, `recovery.json`,
failure markers and complete service logs. A printed pass alone is insufficient.
The driver checks shutdown exits and restart counts, scans logs after stop,
compares source archive contents and complete file names, and removes disposable
containers and networks while retaining their volumes. Workerd's wrapper can exit
1 after forwarding SIGTERM; critical storage/controller processes must exit 0.
