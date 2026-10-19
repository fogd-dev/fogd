# Queue activation review response

The [Claude review](m11a-activation-claude.md) found no blocking correctness issue
in the private-artifact checkpoint. Its availability, recovery, and admission
findings led to the following changes and explicit remaining gates.

- Startup recovery catches a queue backend failure per app, persists unknown pause
  state and a bounded diagnostic, and leaves its route paused. Other apps remain
  routable. Metadata write failures still stop the whole controller. Startup waits
  for bounded backend commands before opening listeners; it does not promise
  immediate startup while a fleet is unreachable.
- The live built-controller probe confirms that celld health handles the platform
  bootstrap correctly. Bootstrap's ordinary HTTP 503 does not prevent readiness.
- A held artifact still requires original approval retry. Other pending submissions
  can be rejected to free admission capacity. Transferring a hold to a corrected
  migration artifact remains an admission prerequisite.
- Capability marking occurs when a queue request is recorded, before any approval
  effect. Startup refuses unmarked queue declarations, including before the first
  journal exists. Public admission still rejects queues.
- Retirement explicitly refuses queue apps until queue isolation and recovery are
  qualified. This prevents the ordinary retirement path from bypassing a hold.
- Bootstrap uses an OS temporary directory, so interrupted bootstrap files do not
  appear as unreferenced uploaded artifacts. A missing journal requires an unpublished
  fleet and no active pointer before it can authorize bootstrap. This catches the
  reviewed stale-metadata case; arbitrary mismatched backup pairs remain unsupported.
- Startup validates that a hold names an activation for the same app with an
  activating or failed status. Invalid ownership fails before runtime effects.

Tests cover ambiguous writes, backend response loss, real controller process kills
with persistent runtime stand-ins, invalid hold ownership, stale metadata, missing
capability, and a failed queue recovery alongside an active app. The Docker probe
covers the combined built coordinator with real celld and native Void app processing.
It injects a lost response and reconstructs the controller object; it does not claim
to kill the Docker controller process or exercise the public approval API.

The [activation explanation](../queue-activation.md) lists the remaining public
operator, corrected-artifact, backup/retention, retirement, and approval/gateway gates.


The [follow-up review](m11a-activation-followup-claude.md) also reports no blockers.
Its final-image probe was pending at review time. Subsequent probes passed, and
the final fresh-fleet probe requires the configuration update to adopt a distinct
runtime version. The selected evidence records that image and its source hashes,
including the small change allowing rejection of unrelated pending submissions.
The hold-owning artifact remains protected. The diagnostic-clearing assertion now covers explicit retry.

Known limits from the follow-up remain explicit: startup waits on bounded recovery
commands; a missing configured slot is a global metadata/configuration error; the
recovery diagnostic is stored in controller state rather than surfaced in an admin
control yet. A pending bootstrap paired with a newer, mismatched bucket snapshot is
not fenced. Recover matching controller and bucket snapshots; arbitrary mixed-state
recovery is unsupported.
