# Shared checklist

This native Void room is the first implementation of [M11b](../../docs/m11b.md).
Open `/?room=shared` in two browsers after deployment. The native Void UI retains
pending edits in browser storage, waits for a snapshot before replaying them, and
settles server receipts or rejections. WebSocket and HTTP state live at `/rooms/:room`.
Bounded node-failure, update, SSE, idle-eviction, ownership-movement and stopped
recovery probes pass with the documented patches. The M11b acceptance audit remains
open; the example is not a general collaborative editor.

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
IDs. The browser implements that protocol using the native Void client and an explicit
[send-without-buffering patch](../../docs/patches/void-websocket-send.md). Carry the
patch when building this source outside the workspace; unpatched Void 1.1.11 does
not provide `sendIfOpen`. Both-target offline builds use the patch.

For the current disposable M11b fixture, run
`FOGD_ENV_FILE=... node scripts/live-board.mjs NEW_OUTPUT`. It updates `live-probe`
and deploys `checklist` through scoped CLI submissions, requiring two usable fleets.
The probe checks duplicate/conflicting IDs, concurrent edits, typed refusal, and
separate app/room storage through Chromium and workerd. Its real-runtime evidence
is separate from the SQLite unit tests, which inject a receipt-write failure and
verify rollback of both the item and revision.


## Browser behavior and reproduction

A loaded page can retain offline edits; opening a new page still requires the server.
Pending operations use individual keys scoped by room and origin, so two tabs do
not overwrite a shared array. Saved items change only after an authoritative server
snapshot. The status reports connection state, revision and pending count.

On a lower fresh server revision, the page displays the restored board and stops
writes. After reviewing it, explicitly choose **Accept restored state and retry
pending edits** to reset this browser's watermark and resend its retained operations.
This does not restore previously acknowledged edits absent from an older snapshot.
Malformed local data or storage failures stop writes without silently dropping work.

With the UI deployed on the disposable M11b fixture, run
`FOGD_ENV_FILE=... node scripts/live-browser.mjs NEW_OUTPUT`. It uses a real workerd
connection, a writer-side WebSocket proxy to delay initial snapshots/drop one ack,
and a second directly connected browser. It checks the CLOSING window, reload with
an unknown outcome, rejection settlement, and explicit rollback acceptance. The
rollback case injects a higher browser watermark; physical restore is a later test.

## Process-loss verification

With this example approved as `checklist` on slot-2 of the disposable M11b fixture,
run the physical failure probe. Keep other clients off that fixture while it runs:
it identifies the room owner from the single newly resident cell.

```sh
FOGD_ENV_FILE="$PWD/.fogd/m11b-fixture/probe.env" \
  node scripts/live-failure.mjs .fogd/checklist-process-failure
```

The probe kills the owning celld process, requires another acknowledged edit before
restarting it, then kills and restarts workerd and requires another edit. Cleanup
restarts the selected service even if an assertion fails. Evidence records browser
close codes and time from kill initiation through the new acknowledgment. These
measurements include client retry and lease recovery, not a latency guarantee.
Non-owning ingress failure, forced idle eviction and stopped restore are separate
checks.

## Idle eviction verification

On the same disposable fixture, deploy this example as `live-probe` on slot-1,
then run:

```sh
FOGD_ENV_FILE="$PWD/.fogd/m11b-fixture/probe.env" \
  node scripts/live-idle.mjs .fogd/checklist-idle
```

Keep other clients off the fixture. The probe observes a connected room for
30 seconds under the ordinary idle policy, then temporarily recreates only slot-1
with `CELLD_IDLE_EVICT_S=5`. It requires the new room to leave both nodes' resident
sets before applying another edit over the original socket. The message handler
requires room parameters restored from Void's socket attachment. The second edit
must advance the revision once and retain the first item.

Cleanup restores the original replica configuration and waits for celld health.
The private output contains a Compose file with credentials; keep it local. This
finite observation does not establish an unlimited idle lifetime or behavior when
room ownership moves to another node.

## Non-owning ingress failure

With `checklist` active on slot-2 of the disposable fixture, run:

```sh
FOGD_ENV_FILE="$PWD/.fogd/m11b-fixture/probe.env" \
  node scripts/live-ingress.mjs .fogd/checklist-ingress
```

The probe identifies the room owner from runtime state, then temporarily orders
workerd's backends to select the other node for the loaded browser's reconnect.
It kills that non-owner and requires the selected socket to close. The next edit
must be acknowledged while the killed ingress remains stopped and both the owner
and workerd retain their process start times. The original gateway configuration
and killed replica are restored during cleanup. Use a quiet disposable fixture;
this probe intentionally interrupts its gateway connections during setup.

If interrupted before cleanup, restore the original fixture with:

```sh
FOGD_ENV_FILE="$PWD/.fogd/m11b-fixture/probe.env" \
  node packages/cli/bin/fogd.js up
```

Remove any `ingress-compose.json` left in that run's private output directory after
restoration; it contains credentials. The direct-owner control process has a
two-minute deadline. Its normal cleanup removes its private state file.

## Compatible updates on the patched runtime

The [celld candidate](../../docs/patches/celld-preaccept-attachment.md) is required
for this gate; pinned upstream celld closes the old socket with 1011 when the first
message reaches the replacement handler. Use the disposable M11b fixture with the
candidate image. Reset the base v1 app, then run:

```sh
FOGD_ENV_FILE="$PWD/.fogd/m11b-fixture/probe.env" \
  node scripts/live-board.mjs .fogd/checklist-update-base
FOGD_ENV_FILE="$PWD/.fogd/m11b-fixture/probe.env" \
  node scripts/live-update.mjs .fogd/checklist-update
```

The v2 overlay changes only the release marker. The probe submits it through a
scoped credential and approves the exact digest. A v1-format pending record stays
in local storage across approval; the already-loaded v1 client flushes it on the
original socket and receives a v2 acknowledgment. The room guard remains enabled.
To combine observed idle eviction with handler replacement, reset v1 again with a
fresh output directory and replace the second command with:

```sh
FOGD_ENV_FILE="$PWD/.fogd/m11b-fixture/probe.env" \
  FOGD_LIVE_SLOT=slot-2 FOGD_LIVE_APP=checklist FOGD_LIVE_UPDATE_AFTER_IDLE=1 \
  node scripts/live-idle.mjs .fogd/checklist-idle-update
```

The combined probe checks the five-second setting in the running containers and
observes the new room leave residency before approval. It restores the original
idle configuration afterwards. Use fresh output directories for every run.
SSE, ownership moves and stopped restore remain separate gates.

## Route pause during approval

On the same candidate runtime, reset v1 with `live-board.mjs`, then run:

```sh
FOGD_ENV_FILE="$PWD/.fogd/m11b-fixture/probe.env" \
  FOGD_LIVE_ROUTE_PAUSE=1 \
  node scripts/live-update.mjs .fogd/checklist-route-pause
```

The probe restarts workerd before activation to select the room owner as ingress;
that setup reconnect is recorded separately. It briefly freezes the non-owning
replica with Docker pause, holding the real approval at replica readiness. New HTTP
requests return 503 and new WebSockets are refused, while the existing socket
commits an edit. After unfreezing the replica, approval completes, the saved v1 edit
receives a v2 acknowledgment, and a fresh socket receives the final snapshot.

Routing pause is not a write barrier. This fixture has no D1 migration and does not
qualify incompatible schema changes. Do not combine this mode with the idle mode.
Normal cleanup unfreezes the replica and restores workerd. If forcibly interrupted,
run `docker unpause` on the paused container in this disposable fixture, inspect
the approval status, and run `fogd up` with the fixture environment before retrying.
Remove any private `route-pause-compose.json` left in the output directory after
restoration; it contains credentials.

## Experimental SSE observer

`/watch?room=shared` is a read-only view of the same room. Native `void/live`
notifications trigger an authoritative room snapshot, and successful registration
or resubscription also fetches a snapshot. Missed notifications are not replayed.
The [initial evidence](../../docs/evidence/m11b-sse-initial.json) covers native hints,
gateway restart with a missed edit, and a finite idle observation.

This is not a fully qualified live-update feature yet. The
[version-pinned registration patch](../../docs/patches/void-live-registration.md)
fixes the confirmed race, and a deployment cancellation/reconnection check passes.
A [bounded publication-stall and cross-app isolation drill](../../docs/evidence/m11b-sse-failure.json) also passes. Room moves and stopped recovery also pass; see the [bounded M11b acceptance](../../docs/m11b-acceptance.md). No sign-in is provided, and anonymous readers can
consume the topic's subscription capacity. Publishing is best effort and never
changes an operation's durable result.

Use fresh fleets: the live API infers an additional Durable Object, and fogd rejects
adding it to an existing app's resource identity. From the repository root:

```sh
FOGD_PROBE_HTTP_PORT=8905 FOGD_PROBE_ADMIN_PORT=8906 \
  node scripts/queue-probe/setup.mjs .fogd/sse-fixture fogd-m11b-sse-example
FOGD_ENV_FILE="$PWD/.fogd/sse-fixture/probe.env" node packages/cli/bin/fogd.js up
FOGD_ENV_FILE="$PWD/.fogd/sse-fixture/probe.env" \
  node scripts/live-board.mjs .fogd/sse-base
FOGD_ENV_FILE="$PWD/.fogd/sse-fixture/probe.env" FOGD_LIVE_SSE_IDLE_SECONDS=30 \
  node scripts/live-sse.mjs .fogd/sse-browser
```

The browser probe restarts this fixture's gateway, affecting both example apps.
Recorded initial evidence uses the opt-in celld image; the setup command uses the
normal default runtime. Use the pinned candidate and additional drills below to reproduce the recorded lifecycle evidence. Stop clients before
restoring a snapshot. A lower revision after reconnect requires explicit reload;
restoring under an uninterrupted observer is outside this example's contract.

To reproduce the upstream race after obtaining the pinned Void source, run:

```sh
node scripts/void-live-registration-regression.mjs \
  .upstream/void/packages/void/src/runtime/live-server.ts
```

The assertion fails on the pinned unpatched source and passes with the candidate. The script uses actual server
methods with in-memory storage and delayed transport, so it isolates the race
without claiming a celld scheduling reproduction.


### SSE across a compatible deployment

Use the opt-in celld candidate required by the nested WebSocket update probe.
In the disposable fixture's resolved Compose file, set
`CELLD_DEPLOY_MAX_AGE_S` to `"5"` in both `slot-2-a` and `slot-2-b` environments,
then run `fogd up` with that fixture environment to apply the setting. Reset v1
with `live-board.mjs` and use a fresh output directory:

```sh
FOGD_ENV_FILE="$PWD/.fogd/sse-fixture/probe.env" \
  node scripts/live-sse-update.mjs .fogd/sse-update
```

The probe verifies the setting in both running containers, approves the v2 artifact
through the ordinary CLI, and observes SSE error/reopen, a v2 snapshot after
registration, and a later revision hint. It also runs the preserved-WebSocket
update check. The finite result does not promise a cancellation latency. Restore
the fixture's original setting and run `fogd up` after this dedicated drill.


### SSE publication stall and app isolation

On the disposable SSE fixture with both apps approved, run:

```sh
FOGD_ENV_FILE="$PWD/.fogd/sse-fixture/probe.env" \
  node scripts/live-sse-isolation.mjs .fogd/sse-isolation
FOGD_ENV_FILE="$PWD/.fogd/sse-fixture/probe.env" \
  node scripts/live-sse-failure.mjs .fogd/sse-publication
```

Use the pinned candidate described above and a lease TTL of at least nine seconds.
The fault drill creates a temporary native subscriber to place the topic on the
other replica, then pins this fixture's gateway ingress to the board owner. A new
browser observer keeps its connection on the board node. The other replica pauses
briefly while two edits commit and a revision-specific publication timeout is
logged. This node is also the board log follower; pausing it can evict that follower
and switch acknowledgments to bucket durability. The probe checks both ensembles
before the pause and waits for a newer reopened epoch after each degradation,
confirmed in the fresh lease with peer membership, after resume and during cleanup. Late
hints repair the same observer without reload. This
covers a stall; the timeout does not cancel the underlying publish or guarantee
later delivery. Cross-app checks use identical room/topic names and interleaved
edits, with both snapshots and notification payloads checked.

The probe restores the canonical gateway configuration and unpauses the node in
`finally`. A watchdog invalidates the test if the pause reaches its safety budget.
Force-killing the probe can bypass cleanup: run `docker compose -f <fixture-compose>
-p <fixture-project> unpause slot-2-a slot-2-b`, then `fogd up` with the fixture's
`FOGD_ENV_FILE` to restore ingress. Do not run this drill on a shared stack.


### Healthy room ownership movement

Use the disposable SSE fixture with both checklist apps approved and the opt-in
celld candidate. From the repository root:

```sh
FOGD_ENV_FILE="$PWD/.fogd/sse-fixture/probe.env" \
  node scripts/live-move.mjs .fogd/live-move
```

This drill temporarily changes slot 1's idle policy, placement weights, and gateway
selection. It creates three rooms while balancing is paused, confirms hibernation
without socket closure, and resumes native balancing. Every observed moved board
must reconnect, preserve its original operation receipt, and accept a new edit.
Persisted ownership and receiver reads establish which node serves the board.

The [recorded result](../../docs/evidence/m11b-move.json) has three moved boards,
each with a 1012 close and native reconnect. The physical socket does not survive
a move. No SSE observers attach during this drill, and the room defines no alarms.
Notification topics count toward fleet balancing but are not checklist rooms.

Cleanup resumes balancing and restores the canonical configuration. If the probe
is forcibly killed, run `fogd up` with the fixture's `FOGD_ENV_FILE` to recreate
replicas and restore gateway selection; recreation clears the native in-memory
balance pause. Keep the fixture's bucket and replica volumes.


### Stopped backup and restore

On the disposable SSE fixture with both apps approved and the documented candidate:

```sh
FOGD_ENV_FILE="$PWD/.fogd/sse-fixture/probe.env" \
  node scripts/live-restore.mjs .fogd/live-restore
```

The drill stops the complete installation, backs up through `fogd backup`, and
restores through `fogd restore` into fresh projects. It preserves both apps' state
and approval metadata and verifies the original receipt and conflicting-payload
rejection. It then exercises a separate older-snapshot restore with real browser
history and an offline pending edit. The writer must stop automatic writes until
acceptance, and the observer must require reload. A lower revision is detectable;
a different history at an equal or higher revision is not.

Use new output directories. The drill removes only its projects' containers and
networks to reuse the local ports and Docker address space. It retains source and
target volumes, the backup bundle and private configuration. It closes browsers
before returning the source to service. A backup is not a promise to preserve writes
acknowledged after its snapshot.

If interrupted, inspect the target project names in the output directory. Stop their
containers with `docker compose -f <target-compose> -p <target-project> down`, without
`-v`, before starting the source with its fixture environment. A partial restore can
have `compose.pending.json` instead of `compose.json`. If target cleanup fails,
inspect those projects before restarting the source; the ports may still be occupied.
