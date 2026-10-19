# Route-pause review response

Claude found no blocking defects. The final probe requires the exact
`App activation paused` response for HTTP and a raw WebSocket upgrade, alongside
browser upgrade refusal. It rechecks residency immediately before freezing the
non-owner, records the owner deployment and controller node order, and records when
the saved pending operation is released. A fresh socket must receive the final
snapshot after approval. Assertion and approval-cleanup failures are aggregated.

The handler may be v1 or v2 during the hold, depending on which replica adopts the
release first; either is allowed to write under this compatible-update contract.
The actual reply release is recorded. The final pending edit must use v2.
Gateway ordering only selects the first request after restart; a socket entering
the frozen replica cannot pass the mutation assertion. The intentional setup
reconnect is recorded separately from activation. These checks do not claim
production routing affinity or surviving ownership moves.

The reproduction guide documents forced-interruption recovery. Outer fixture
cleanup can still supersede an earlier thrown error, but the probe saves the
original failure record before cleanup; normal assertion failures unfreeze the
replica and await approval. App name `checklist` is deliberate fixture scope.
