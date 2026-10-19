# Checklist browser review response

The initial browser run passed its happy-path and lost-ack tests, but the reviewer
found two gaps those tests did not cover. Both changed the implementation.

1. Void's pre-open buffer could send before the snapshot gate. Added the minimal,
   version-pinned `sendIfOpen` upstream candidate instead of reading private fields.
   The app throws on false, leaving the operation pending. The follow-up review
   approved the method; its two integration blockers described the tree before
   the callback and Docker COPY edits landed. Both are now present and checked.
   Native-client tests and the browser's synchronous-close/submit case prove the
   SDK buffer stays empty and no operation precedes the delayed initial snapshot.
2. At disconnect the rollback floor includes the shared stored revision. Rendering
   filters against this tab's observed revision, not another tab's future watermark;
   shared persistence still keeps the maximum. Tests cover different tab floors and
   concurrent advancement during connection startup.

The rollback UI now displays the actual lower-revision snapshot before blocking.
An explicit acceptance action resets this browser's watermark and retries retained
pending operations. The browser probe injects a higher browser watermark to exercise
this gate; it is not evidence of physical backup/restore, which remains separate.

Removed the generic SDK error-to-disconnected mapping: parse errors do not prove a
transport close. Storage enumeration skips keys another tab settled concurrently.
Malformed saved operations stop writes instead of being sent repeatedly; v2 must
retain compatibility with valid v1 pending records. Each tab can replay shared
pending operations; receipts deduplicate them. A rejection notice currently appears
in the tab that settles it first; cross-tab notification history is not promised.

The full physical node-failure, preserved-socket update, SSE, idle-eviction, and
stopped-recovery gates remain open. This checkpoint qualifies browser reconciliation
and the explicit patch requirement, not all M11b behavior.
