# Stopped recovery review response

The [design review](m11b-restore-claude.md) accepted the approach and required
stronger assertions. The [implementation review](m11b-restore-final-claude.md) found
no code blocker but inspected the strengthened run before it finished. That run
subsequently completed successfully, including cleanup and source restart.

The final evidence includes both apps, clean non-workerd exits, no OOM or queued
recovery, fresh volumes, actual mounts/networks and pinned images. The original
receipt returns revision 1; changing its payload returns `operation-conflict`.
The writer's actual saved watermark is 2, and both directions of its routed socket
are recorded. A targetA EventSource error and accepted targetB registration precede
the observer's restored-state banner. Explicit acceptance sends one pending ID;
receipt replay and browser reload preserve revision 2 with two items.

The helper changed while the run was executing only to close Chromium if initial
page navigation throws. The runner later gained two success assertions, checked
against the completed artifact: a complete service-exit inventory and an operation
frame type. Other edits report partial target paths and skip source restart when
cleanup fails. None changes the successful path exercised by the completed run.
Those failure-cleanup branches were not fault-injected; the evidence states this
provenance rather than presenting them as tested failures.

The retirement, queue-retirement and CLI retirement implementations have no diff
from the M11b baseline commit `d3c83c1`. The source restarts without building; all
source/target volumes and the bundle remain. Equal-or-higher revision divergence
is not detected. This closes the bounded stopped recovery scenario, not the
separate M11b acceptance audit or a zero-loss recovery claim.
