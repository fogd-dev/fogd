# Shared checklist: server protocol checkpoint

This native Void room is the first implementation of [M11b](../../docs/m11b.md).
It currently exposes WebSocket and HTTP state at `/rooms/:room`; a browser UI,
persistent pending operations, reconnect handling, SSE and failure recovery are
still under implementation. Do not treat this checkpoint as a finished app.

The anonymous fixture accepts same-origin browser WebSockets. It has no membership
or application authentication; use a disposable local stack. Room names are 1–64
lowercase letters, digits or hyphens. The resource name `checklist` pins the generated
`ChecklistWs` identity across source changes.

```sh
pnpm --filter @fogd/example-checklist typecheck
pnpm --filter @fogd/example-checklist build
node --test examples/checklist/test/*.test.mjs
```

After ordinary scoped `fogd deploy` and exact approval, a connection receives a full
snapshot. Send an operation like:

```json
{"type":"operation","opId":"add-1","operation":{"kind":"add","itemId":"first","text":"Ship a demo"}}
```

Or set a known item's checked value explicitly:

```json
{"type":"operation","opId":"check-1","operation":{"kind":"set","itemId":"first","checked":true}}
```

A successful transaction commits the edit, revision and receipt together, then
replies with `ack` containing `opId`, the original revision and release. A duplicate
accepted operation returns its original receipt without reapplying the edit. A
changed payload under an accepted operation ID returns `operation-conflict`.
Accepted operations and recorded semantic rejections share a 1,000-receipt limit
per room; receipts are never evicted.
The room holds at most 100 items, with text up to 160 characters. These are fixture
bounds, not platform quotas.

Semantic refusals return `rejected` with `opId` and `reason`, keeping the socket open.
They leave board state and revision unchanged but consume a durable receipt, so
an unknown-item rejection cannot later become an edit when another user creates
that item. Once receipt capacity is reached, every new operation remains refused.
Malformed operation IDs are refused without reservation. Clients
must settle rejected pending work rather than reconnecting and retrying it forever.
Malformed protocol messages can still trigger the native SDK's close behavior.

The sender receives its acknowledgment and full snapshot; peers receive the
snapshot separately, excluding the sender so its disconnect cannot block them.
The upstream broadcast can still abort if another closing peer throws; that limit
will be addressed in reconnect/SSE acceptance, not hidden by a fogd shim. `GET` on the
same path returns that snapshot. Broadcast delivery is not durable; a reconnecting
client must reconcile from the snapshot and retry unknown outcomes with the same
IDs. The browser implementation of that protocol is the next step.

For the current disposable M11b fixture, run
`FOGD_ENV_FILE=... node scripts/live-board.mjs NEW_OUTPUT`. It updates `live-probe`
and deploys `checklist` through scoped CLI submissions, requiring two usable fleets.
The probe checks duplicate/conflicting IDs, concurrent edits, typed refusal, and
separate app/room storage through Chromium and workerd. Its real-runtime evidence
is separate from the SQLite unit tests, which inject a receipt-write failure and
verify rollback of both the item and revision.
