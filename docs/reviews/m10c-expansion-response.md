# Expansion review amendments

The [design review](m10c-expansion-claude.md) supports stopped-snapshot expansion
and simplifies the [original proposal](../m10c-expansion.md). These amendments
supersede the proposal where they differ.

## Accepted design changes

Keep the hand-written `compose.yaml` as the sole source. `fogd docker render`
uses Compose's `--no-interpolate` JSON output and adds a fleet using the existing
replica definition. Preserve environment placeholders and absolute build context.
The prototype full generator was discarded before commit.

Compose also normalizes the interpolated project name and freezes derived volume
and network names in that output. Remove derived resource names and require an
explicit `COMPOSE_PROJECT_NAME` in rendered installations. Reject external or
explicitly named source resources. Compare resolved two-fleet output and verify
that separate project names resolve every volume/network to separate names.

Use the existing fresh-restore path for expansion, with typed transformation
metadata. Derive restoration/check inventories from the target; derive source
writer checks from the source. Added volumes take the verified-empty path. Extend
the image map only with images already present in the source snapshot. Existing
controller state is copied unchanged. New storage prefixes must be disjoint from
both configured fleets and retained retirement prefixes.

Keep the render command because operators need a buildable template for three-fleet
installations; resolved recovery output remains private and image-pinned. Rendering
alone does not upgrade an existing installation. Up and TLS import refuse a fleet
layout change when existing project containers or retained replica volumes show a
different layout. Direct Docker commands remain an operator responsibility.

Expansion requires readable controller state in the stopped snapshot. A populated
installation has that state; an unused installation can persist it by issuing a
scoped credential before capture. Do not silently substitute empty metadata for
a missing or damaged controller archive.

## Qualification gates

Verify source state and volumes remain unchanged by expansion. Use a certificate
covering all three app names and the replacement name. Check three-app approvals,
isolated data, restart, full backup/restore, middle-fleet retirement/reuse, interrupted
target refusal, and paired resource observations before claiming M10 completion.
Reject shrinkage and unsupported fleet counts explicitly. Kubernetes keeps its
separate two-fleet configuration; its CLI rejects Docker fleet-selection options.

## Code-review changes and qualification

The [first code review](m10c-expansion-code-claude.md) found no blocker for the live
drill and identified three improvements. Startup/TLS now checks only fleet
selection against retained resources, avoiding a new full-recovery restriction on
ordinary startup. Backup retains its strict qualification boundary. Skipped replica
volumes are rechecked empty after restoration. Restore rejects image maps with
missing or extra service keys. Shared resolved configuration avoids repeated
inspection during startup.

All gates above have now passed locally, including fresh rendering with three
approved apps, source-volume comparison, full restore, native account sessions,
middle-fleet retirement/reuse, interruption/refusal/retry, and paired resource
observations. The [report](../report.md) records the harness corrections and retained
limitations. Unit tests pass 83/83; example builds and the quality gate pass.

## Final review changes

The [final Claude review](m10c-expansion-final-claude.md) found no implementation
blocker and requested stronger evidence before completion. The expansion drill now
matches specific stderr refusal reasons instead of accepting any failed command.
Its source check says every archived file is unchanged: `tar --compare` does not
prove the absence of additional files. The checked-in drill subsequently passed from start to finish, using a
pre-expansion scoped token after restoration. The stricter running-source and
occupied-target refusal checks passed, as did third-app approval, fourth-app
capacity refusal, and gateway/replica restart.

The recovery drill now asserts the selected app occupies the middle fleet and
polls its readiness in the ordinary restored installation. Load evidence requires
positive request counts as well as zero errors. Python 3 and rendered host-override
limits are now documented. The report clarifies that the later paired measurement
restarted disposable source copies sequentially.

The measurement timing assertion deliberately refuses a run if metrics start
outside any load window; it can fail safely due to process-start ordering. A future
start handshake would reduce this harness race. Existing recorded windows pass the
assertion. Sequential phase ordering and shared-host noise remain explicit limits.
