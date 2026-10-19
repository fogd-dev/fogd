# SSE fault qualification review response

Claude's two reviews narrowed the fault claim and strengthened cleanup. The
[first review](m11b-sse-failure-claude.md) rejected conflating a frozen observer
connection with a publication stall. The [follow-up](m11b-sse-failure-final-claude.md)
found no false pass, but required disclosure and recovery of the log-follower fault.

The drill uses a temporary native subscription to place the topic separately from
the fresh browser connection. It records real send/ack times, correlated revision
logs, unchanged transports, source-derived ids corroborated by residency, and a
lease-aware watchdog. Recovery uses the existing observer; no reload masks failure.
The identity helper checks its derivation against the real board id too.

The paused node is also a log follower. The evidence explicitly includes this
replication fault, requires open peer ensembles before and after, and records
runtime replication transitions. Cleanup checks pause state before unpausing and
waits for gateway routing. Docs retain manual recovery instructions for a forcibly
killed test process. The final successful run includes both late hints, but the
contract only needs a hint that triggers the authoritative latest snapshot; it
does not require delivery of every transient hint. A timeout diagnostic may occur
before the browser receives an output-gated acknowledgment, and only one of the
two publications need time out.

Cross-app checks assert subscription id, topic, exact hint revisions, and isolated
snapshots. Browser page errors fail the drill. Console and network diagnostics
remain advisory; the assertions directly check delivery and visible state. These
results do not cover hostile tenants, permanent publication loss, or room moves.


The [replication follow-up](m11b-sse-ensemble-claude.md) found that a degraded
ensemble leaves its persisted lease marked open. The final guard therefore checks
actual log transitions across each container's available history: every degradation
needs a later, newer reopened epoch, also present in the host's fresh lease. It
checks before fault injection, after resume, and during cleanup. Four regression
checks reject a persisted-open but degraded log, same/incorrect-host/stale epochs,
a later degradation, and missing or malformed evidence. This addresses the
reviewer's required transition check without treating `active` as a health flag.
