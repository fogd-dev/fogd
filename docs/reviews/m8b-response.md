# M8b review amendments

Claude's [spec review](m8b-claude.md) supports the scoped-credential and quota slice
with clarifications. Gemini remains unavailable after the recorded provider quota
failure; no second-provider verdict is implied.

- Credential scopes are immutable: revoke and reissue to change them. Issue and
  revoke run on the same controller queue as submissions, and scope/revocation are
  rechecked inside that queue. Status remains restricted to the submitting identity.
- Store credentials in a separate controller-volume file with hashes only. This
  keeps credential management separate from deployment state and avoids the existing
  admin state spread exposing hashes. All admin projections explicitly omit hashes;
  tests cover that surface as well as submitter status.
- Validate the existing global pending limit and new limits as positive safe integers.
  Both pending limits count failed as well as pending releases. Logical artifact
  bytes count decoded file contents, not filesystem blocks or path metadata.
- Reconstruct retained bytes from disk. Conservatively count orphan directories;
  do not automatically delete potentially useful recovery evidence after mismatched
  metadata restoration. M10 owns safe pruning. Capacity errors require operator
  attention rather than silent deletion.
- Bound concurrent authenticated uploads as well as retained bytes. The activation
  execution copy, private revision history, application D1/R2 growth, and filesystem
  overhead are outside the artifact-byte quota. No hostile-tenant isolation claim.
- The legacy deploy token becomes optional at the server/Compose layer. Local
  `fogd up` still bootstraps it for existing workflows; the HTTPS/shared-mode slice
  must disable that behavior when scoped access is required.

The original [M8b spec](../m8b.md) remains the review baseline. M8b1 alone does not
qualify public or shared-network hosting. M8b2 must preserve HTTPS origin semantics,
separate public ingress from internal control endpoints, and test recovery with TLS
and scoped credentials enabled.

## Implementation review and qualification

Claude's [implementation review](m8b1-code-claude.md) found no blockers. The legacy
team token retains the existing global pending limit; the narrower per-credential
cap applies to scoped identities. Quota startup errors now direct operators to the
artifact directory, and non-object credential requests receive a fixed error. CLI
status help refers to a deploy credential rather than only the legacy team token.

A Docker qualification admitted two simultaneous maximum-size artifacts (32 MiB
each) under the default 512 MiB controller limit. The observed controller peak was
376 MiB, with no OOM kill or restart. Both artifacts were counted exactly, then
rejected; the temporary drill credential was revoked. This is one measured upload
workload, not a guarantee for all concurrent runtime/admin activity. Slow accepted
uploads can occupy the bounded slots until the request timeout.

The scoped CLI smoke passed twice, including a fresh-volume restore with legacy
access disabled and artifact capacity set to the retained usage. The valid token
continued to read its status, the revoked token stayed rejected, and further upload
was refused at the recovered quota. TLS remains a separate M8b2 qualification.
