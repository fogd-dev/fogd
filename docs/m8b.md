# M8b: controlled shared operation

Give each teammate a revocable deployment identity, bound storage consumption, and
provide an authenticated HTTPS path before treating fogd as a shared service.
Application accounts remain separate from platform access. This milestone does not
claim hostile-tenant isolation, enterprise identity integration, or Internet-wide
availability.

## Sequence

First qualify scoped deploy credentials and quotas (M8b1), then HTTPS/access policy
and recovery/upgrade evidence with those controls enabled (M8b2). Each slice gets
its own implementation review and committed evidence. Local legacy behavior remains
available for existing examples, but shared mode refuses the legacy team-wide token.

## Scoped deployment identities

An administrator issues a named deploy credential for an explicit nonempty set of
app names. Generate a high-entropy token once, return it once, and persist only its
hash and opaque identifier. An administrator can list metadata and revoke it. Token
issuance/revocation use existing administrator authentication and CSRF protection.
A teammate cannot issue credentials, approve deployments, inspect private artifacts,
or alter app secrets. Authentication records a stable credential ID as submitter.

Enforce app scope before staging any artifact. A credential can inspect only its own
submissions, including after app scope or another credential changes. Revocation
prevents subsequent submissions/status requests; it does not roll back approved code.
Check authorization again within the serialized submission mutation so revocation
cannot race a queued upload into storage. Do not expose token hashes in API metadata.
Existing pending releases remain reviewable by admins after credential revocation.

Keep one bootstrap administrator in this slice. Multiple administrator identities,
SSO, automatic expiration, and organization hierarchy remain explicit gaps. This is
trusted-team deployment policy, not a hostile-code sandbox.

## Bounded control-plane storage

Configure total retained artifact bytes and per-credential pending request limits.
Refuse an upload before writing files when it would exceed capacity. Count retained
active, rejected, superseded, failed, and pending artifacts; reject malformed numeric
limits at startup. Reconstruct actual retained size on restart rather than trusting
client size metadata. Serialize admission with other state changes. Do not delete
migration evidence or active data to satisfy a quota. Operators receive fixed,
actionable quota errors; retirement/pruning follows in M10.

Resource heap/CPU/body limits already bound parts of runtime use. Artifact limits do
not bound application D1/R2 growth or prevent resource exhaustion by approved code.
Shared operation still needs storage monitoring and an operator policy for those
remaining limits.

## HTTPS and access policy

M8b2 will qualify TLS for both app and admin ingress, preserve native Void secure
session behavior, and keep runtime/control internals private. Use operator-provided
certificates or a documented local test authority; do not modify system trust stores.
The CLI must verify certificates using explicit trust configuration, never a global
TLS-verification bypass. Include certificates/keys in the installation recovery
contract. Shared mode refuses startup on publicly bound plaintext ingress and
refuses unscoped legacy deployment credentials.

## Acceptance

Two named credentials can submit only their allowed apps and read only their own
status. Cross-app submission, cross-identity status, administrative access, and
revoked credentials fail without storing artifacts. Restart and installation restore
retain scopes/revocation. Quota refusal leaves state and disk unchanged, including
after restart and concurrent submissions. Token values/hashes stay out of status and
artifact responses. Existing approval and account fixtures continue to pass.

M8b2 adds real HTTPS CLI/browser deployment and login, certificate rejection/trust
checks, plaintext exposure refusal, upgrade from a backed-up M8a installation, and
fresh-volume recovery with scoped credentials and TLS state. Record any remaining
shared-hosting gaps instead of presenting this as a production security audit.
