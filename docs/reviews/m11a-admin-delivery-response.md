# Admin delivery review response

The [Claude review](m11a-admin-delivery-claude.md) found no blockers and identified
several changes that improve intent binding, operator feedback, and test validity.

- CLI resume requires an explicit deployment ID and digest. It no longer substitutes
  the active ID fetched during command execution. Tests reject a different ID with
  the same digest, missing identifiers, and extra arguments.
- The serialization test waits until the HTTP mutation has entered `exclusive`
  before releasing the queued activation change. It verifies zero runtime effects
  while waiting and refusal after the activation gains a hold.
- Confirmed pause clears a previous recovery error. Unconfirmed runtime operations
  return 502 rather than a validation-style 400. Storage uncertainty remains 503.
- The page explains that operator pause persists across approvals, shows the active
  deployment ID and digest, and hides controls for retired, quarantined, and pending
  bootstrap fleets. Null input is rejected as a non-object before effects.
- Runtime hashes are absent from delivery and general admin views; tests retain the
  original values in storage while verifying API/page/CLI redaction.

Observe remains an explicit observation rather than automatically switching to a
pause operation during uncertainty. It can materialize a cell, which is why it uses
POST with CSRF. Every published consumer has already received artifact approval.
The lifecycle still requires confirmed pause before migrations; observing cannot
release its hold. Operators use pause when they need to establish paused delivery.
[ADR 030](../decisions.md#adr-030-bind-delivery-resume-to-an-inspected-approval)
records that choice.

The live probes exercise admin HTTP controls and browser buttons against real celld.
The app was staged privately before these probes; public queue upload and full
approval-flow admission remain unqualified. Corrected-artifact hold transfer,
backup/retention, and retirement/isolation remain later gates.
