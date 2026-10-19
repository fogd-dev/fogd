# Queue recovery review response

Claude accepted the immediate refusal boundary and identified a Kubernetes
environment bypass. The original [proposal](m11a-recovery-guard-brief.md) and
[review](m11a-recovery-guard-claude.md) are preserved.

## Accepted changes

- Reject `envFrom` for main and initializer containers in Kubernetes recovery.
  Tests cover both locations.
- Inspect live metadata before backup stops writers. Keep the archived-state
  check after stopping to cover a racing queue submission. The Docker preflight
  has a real-container negative probe with a synthetic permanent queue capability;
  it refuses without creating output or changing container states. The probe
  restores original metadata before restarting its temporarily stopped controller.
- Check deployment queue declarations as well as app state and the permanent
  capability. This change was already in the working tree when the review finished.
  Unknown recovery capabilities also refuse.
- Centralize the Kubernetes controller claim name. Reject duplicate and ambiguous
  archive entries for root controller state. Test the competing `./state.json` and
  `state.json` case. Document refusal when state has never been initialized.

The CLI predicate remains local: it imposes a stricter qualification boundary than
controller validation, which permits supported queue state. Sharing a permissive
controller validator would blur that distinction. The short declaration check has
explicit coverage without introducing another package API.

The full post-stop racing-submission backup case and a live Kubernetes queued
backup negative remain unqualified. Existing restore entry-point tests and the
Docker preflight probe cover this slice; they do not establish the next protocol.

## Next protocol direction

Drop the proposed permanent supervisor deadline. The retained immutable bundle
preserves the original records, while expired records are already ineligible for
normal delivery. A restore-time age check plus first-boot detection can report the
actual limit without introducing shared release files across replica volumes.
This changes the intended guarantee: delayed startup can allow expiration before
controller detection. It must never be presented as prevention of message loss.

Use existing persisted operator pause under the backup command's exclusive-operator
contract, then verify the stopped metadata still satisfies the snapshot requirements.
Concurrent resume or new queue admission must fail the final snapshot check. An
empty observed queue can conservatively use observation time for later arrivals,
provided the clock policy is stated. Record the pinned runtime's retention contract;
refuse physical-count/backlog discrepancies rather than inferring what expired.

The next implementation should record verifiable queue observations, carry an
explicit recovery receipt into restored controller metadata, detect delayed startup,
and keep delivery paused until the operator has addressed possible expiration.
Ordinary pause must not erase an unresolved recovery diagnosis. Qualify this through
a real pending-work Docker backup/restore and injected-clock expiry tests before
opening queue admission. No exact-once or running-handler drain guarantee follows.
Kubernetes queue recovery remains refused until its own protocol qualifies.
