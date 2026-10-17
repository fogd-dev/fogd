# M10a design review response

Claude's [review](m10a-design-claude.md) accepts the bounded slice with concerns.
Keep the original proposal and apply these amendments.

Record the bucket owner observed during controller initialization and successful
claims in a separate in-memory map. Capacity reports show that cached owner beside
controller assignments. Duplicate ownership remains visible even when the app's
controller record points at another slot. Never free a slot because those views
disagree. Reporting does not read the bucket or persist derived capacity state.

State explicitly that occupancy is the controller's current observation, refreshed
on restart and claims, not a live bucket inventory. Retained bytes include rejected
and superseded artifacts; rejecting a proposal frees pending capacity only. The
legacy team token counts globally and has no per-credential limit. Report independent
limits without suggesting a guaranteed order of refusal or reserving slots.

Exclude bucket prefixes, node addresses, credential hashes and tokens, secret values,
and private runtime versions. Keep capacity separate from deployment serialization.
Use existing HTTP authentication tests plus a small CLI invocation against the test
HTTP server to compare output; no cluster or extra live fixture is needed for this
read-only command. Slot retirement, resource measurement, and deletion remain later
slices.

## Implementation review

Claude's [code review](m10a-code-claude.md) approved the implementation with no
blockers. Accepted its test suggestions: assert report counts at actual global and
per-credential refusal boundaries, cover ownership reconstruction through the real
controller after metadata loss, and resolve the CLI entrypoint relative to the test
module so the test does not depend on the shell's working directory.
