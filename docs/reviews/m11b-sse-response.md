# SSE review response

SSE remains experimental. The registration/delivery race reproduces against Void's
actual server methods: registration succeeds, the row is deleted during delivery,
and subsequent hints are lost. Native browser success does not close that gap.
The [patch review](m11b-sse-race-claude.md) recommends pending registration state,
monotonic revisions, and guards against stale completion; implementation and the
concurrency cases listed there are the next step.

The observer uses native Void's documented fetch and EventSource adapters. Real
transport errors invalidate older snapshot responses. Initial or repeat control
failure shows `Not subscribed`; a reload creates a fresh client and explicitly
accepts current state. SDK message errors refresh authoritative state without
invalidating registration. Focused tests exercise the actual native client with
modelled EventSource and control transport, alongside snapshot-order tests.

Room code sends durable replies and peer snapshots before launching publication
without awaiting it. Failed and timed-out hints log diagnostics; invocation
cancellation can still lose a hint. Unit tests qualify failure handling, not real
runtime publication failure. A room snapshot response disables caching.

The browser probe uses actual workerd restart to close the stream, blocks this
browser's reconnect requests while an edit commits, and then permits reconnect.
A new registered subscription fetches that missing edit. The 30-second idle run
receives a later hint without another observed reconnect. Resource inference
adds `VOID_LIVE`; fresh fleets are necessary because current fogd updates require
stable resource identities. The existing server-protocol probe still passes with
both generated classes present.

Open gates include the upstream race, deployment-age cancellation, real publication
failure, and cross-app SSE isolation. No polling fallback or replay log is added.
