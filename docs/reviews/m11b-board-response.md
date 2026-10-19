# Checklist server protocol review response

Accepted the two blockers and reran the real-runtime probe after fixing them.

- Sender reply failure no longer skips peer notification. The room sends the sender
  its receipt and snapshot, then broadcasts separately excluding that sender. The
  new close-after-send case passed: the other browser received revision 4.
- Ordinary GET validates the same room-name rule as an upgrade, returning 400 before
  initializing storage for an invalid room. The Docker probe checks it.

Choose durable semantic rejections: refusals with a valid operation ID occupy a
receipt and retain their reason across state changes. They do not bump revision.
Capacity is monotonic; after 1,000 receipts new operations remain refused while
prior receipts still resolve. Invalid IDs receive a bounded empty ID and no receipt;
the upcoming browser must validate stored operations before retrying them.
The additive nullable reason column preserves earlier accepted receipts. Real SQLite
tests verify permanent rejection after item creation and the earlier schema upgrade.

The reviewed Docker probe also checks initial snapshots (including the pre-101
buffering path), concurrent revisions, duplicate/conflicting IDs, sockets staying
open after semantic refusal, cross-origin upgrade refusal, and app/room state
isolation. It does not qualify the browser outbox, node failure, SSE, or updates.

Kept outbound schema validation for the JS model's result and the HTTP snapshot;
this duplicates SDK validation but preserves a clear checked TS/JS boundary.
Schema setup remains idempotent on each hook in this bounded fixture.

Upstream note: Void 1.1.11 broadcast loops can abort if an unrelated closing socket
throws. No upstream behavior is patched here. Sender exclusion resolves the observed
sender-disconnect path, not every possible fan-out loss. Reconciliation and SSE
acceptance must retain that explicit gap rather than claim durable broadcasts.
