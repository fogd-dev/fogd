# Architecture review response

The final architecture accepts the Codex review's seven requested changes. The
original proposal remains unchanged as review context.

| Finding | Resolution |
| --- | --- |
| Replicas also need bucket credentials | Separate build, runtime, and provisioning credentials; document prefix-scoping requirement |
| Approval is not hostile tenant isolation | Explicit trusted-code scope and private fleet networks |
| Publication, adoption, migration are distinct | Serialize deployments, gate new-app routing, migrate existing apps before publication, verify release on both nodes |
| Multipart handles cannot move across nodes | Mark R2 partial; use ordinary put/get in v0 |
| Void and celld migration semantics differ | Package only app SQL, exclude seeds/auth migrations, use celld ledger and validated order |
| Stable prefix is insufficient | Persist resource identities; reject accidental rename/remapping |
| MinIO needs qualification | Build a pinned compatible upstream release and run celld probes |

D1 primary-only session semantics and workerd TLS termination are now qualified in
the compatibility matrix. Compatibility flags require validation. Idempotency
requires transactionally stored deduplication; ingress does not retry writes.

## Claude feedback

Accepted the no_bundle correction: celld reads the Vite entry and module chunks
as built. No second esbuild pass runs. Keep the ingress internal-route block and
strip generated version metadata. Retain celld as the one migration runner rather
than adopting Void's endpoint; a single documented ledger is sufficient for fresh
fogd databases. Explicitly exclude adopting an existing Void ledger in v0.

## Reviewer execution

Claude and Codex returned source-grounded reviews. Cursor timed out after five
minutes with no final output. Gemini's first command failed because the skill's
example model name was stale. `agy models` provided a valid model; the retry
returned a print timeout after five minutes and no review. Neither empty result
is treated as approval. The user requested longer timeouts and verifiable progress
for future calls, and prefers Claude/Gemini (or Grok) over Codex. Future review
runs use 15-minute limits and diagnostic/streaming output.
