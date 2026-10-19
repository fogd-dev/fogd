# Queue admission design response

Claude reviewed the proposed canonical admission and identified three blockers.
Accept all three before exposing queues publicly. This records next work, not a
claim that admission is implemented.

1. Add explicit controller queue opt-in for the qualified Docker deployment.
   Submission must refuse queues before persisting the capability when disabled;
   approval must also enforce the setting. Kubernetes rendering must keep it off.
2. Classify artifact-only history through durable lifecycle evidence, not status
   alone. Pending or rejected requests still at submitted with no secretRevision
   property are inert only without unaccounted app assignments. A rejected pristine
   failed claim needs a recorded release receipt, persisted atomically with removal
   of its reservation, after existing backend checks prove it unclaimed. Use the
   same accounting in Docker backup and the queue-free Kubernetes/expansion guard.
   Active, retired, failed, held, or uncertain queue lifecycle state retains the
   existing qualification boundaries. Do not discard permanent capability history.
3. Canonical queue naming must be idempotent: retain an app-prefixed name, otherwise
   prepend the app. Void resolves the exact logical name or its unique suffix.
   Keep translation in a separate module and include queues in resource identity
   only when present, preserving old non-queue artifacts.

Initially require one same-app producer/consumer pair and all four qualified consumer
policy values equal to integer 1. Reject unsupported nested options, missing policy,
binding collisions, and out-of-bound names explicitly. Preserve empty generated Void
queue configuration as absence for existing non-queue apps; uploaded canonical
artifacts must omit absent queues. This avoids breaking existing generated builds
while refusing noncanonical empty queue objects at receiveArtifact.

The public acceptance run must use ordinary builds, scoped upload, exact approval,
and derived-name dispatch without private staging. Cover pending-only backup,
claim-failure rejection backup, failed-activation refusal, unsupported-environment
refusal, application retry and duplicate prevention, additive update/overlap, stopped
recovery, and retirement. Existing native probes remain useful evidence, but they
cannot substitute for this integrated public path.
