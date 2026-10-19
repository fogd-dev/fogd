# M11b design review response

Accept all four blocking findings and the protocol/transport corrections.

- Terminal operation failures use typed rejection, settle the pending operation,
  and show an error. Receipt lookup precedes cap/validity checks. Malformed protocol
  closes are distinct from semantic refusal of persisted operations.
- Test preserved sockets across deployment: a v1 page must handle a v2 response and
  v2 must accept v1 input/attachments. Route pauses do not revoke existing sockets.
  Contrast the separately bounded SSE deployment lifetime.
- Choose the explicit idle-eviction test option. Keep a normal-fleet observation,
  then prove eviction in a dedicated configured fixture before claiming wake or
  hibernation behavior. This remains unqualified until executed.
- Room storage owns snapshots. SSE carries best-effort revision hints after durable
  acknowledgment; subscription registration precedes catch-up snapshots. Publication
  failure must not block acknowledgment or substitute for durable state.

Also accept separate owner/ingress failure tests, synchronous SQL transactions,
trusted forwarded-origin checks (missing origins refused), per-operation browser
storage keys, send-only-while-open behavior, and compatible internal pruning alarms.
A lower revision on a fresh connection surfaces rollback and blocks automatic writes;
the baseline restore claims preservation only as of its stopped snapshot.

Drop a new retirement acceptance cycle from this slice; existing offline retirement
rules still apply. Keep two-app isolation, both transports, and offline both-target
builds. The tiny native-room probe passed without a shim, but establishes transport
only. The full checklist and failure/reconciliation tests remain implementation work.
