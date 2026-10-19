# Ownership claim review response

The [initial review](m11a-claims-claude.md) found no blocking safety issue in the
claim ordering but identified reservations that could not be abandoned. Rejection
now releases a pristine local reservation only after confirming matching fleet
configuration and absent owner/deployment objects. The artifact and rejected
request remain for audit. Intent and confirmation persist on either side of the
bucket effect; startup never claims or publishes automatically.

The [follow-up review](m11a-claims-final-claude.md) found a release blocker when
another configured fleet owned the same app. Release now reads the other configured
owners and refuses that conflict. A regression test reproduces the quarantined
cross-fleet case and verifies that neither reservation nor request is discarded.
Another test releases a quarantined but genuinely unclaimed reservation whose
artifact was lost. Rejection write ambiguity is tested before and after commit.

Startup now quarantines otherwise valid pending claims with deployment objects.
Expanded negative cases cover altered approval identity, capability, migration
state, artifact, and configuration. Approval cannot be moved to another app by
editing its request record. The permanent capability requirement and the supported
M10b-and-later enforcement boundary are documented; unsupported older binaries must
not be used as a downgrade path.

Subprocess SIGKILL tests were added after the first review. They exercise ordering
at intent, claim, and confirmation with a file-backed fixture using `saveJson`.
They do not prove power-loss durability or exercise real S3 in the child. The
separate MinIO probe stages working-tree backend source, records hashes, and proves
read-after-write publication checks plus conditional-create rejection with HTTP
412. Unit tests cover the backend's same-app and foreign-app 412 branches. This is
not a built-image full-controller approval drill or evidence for another bucket
provider.

The probe refuses overlap with configured fleet namespaces and retains its small
test prefix and temporary source copy in a disposable installation. A delayed PUT
that arrives after a release absence check remains an operational limitation; the
runbook does not claim that read-only release checks fence outstanding storage
operations. Queue bootstrap and delivery integration remain next.
