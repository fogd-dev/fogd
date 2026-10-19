**Verdict: approve once the blockers below are fixed.** The direction is right: a native `defineRoom` room first, `void/live` SSE as its own acceptance item, app-owned receipts, and no Cloudflare calls. The ack rule also holds up on the pinned runtime. celld holds every response and WebSocket frame until the write is durable (`celld/docs/guguarantees.md`, "acknowledgement rule"), so committing and then sending the ack is enough. Four things in the plan are wrong or missing for the pinned Void and celld, though, and two of them would make the acceptance tests misleading.

## Blockers

**B1. A rejected pending op makes the client reconnect forever.**
- What happens: `ws-server.ts` closes the socket with 1007 when JSON parsing or the client schema fails. `VoidSocket` reconnects after every close except one the user started (`ws.ts`, close handler, fixed 1s delay, no attempt limit). The plan then resends pending ops from local storage on reconnect. An op the server will always reject (too large, invalid under v2, conflicting payload, receipt cap reached) therefore loops: close, reconnect, resend, close.
- Change:
  - Every refusal the server can decide is a typed `rejected {opId, reason}` reply, never a close. That covers conflict, cap reached, and unknown item.
  - The client deletes a pending op when it gets a terminal rejection and shows the error.
  - The client validates an op with the same schema before saving it to local storage.
  - The client schema stays wide enough that a valid stored op never fails server parsing. Put size limits in the handler as a typed reject, not as schema closes.
  - Order in `onMessage`: look up the receipt first (a duplicate returns the stored result, even after the cap), then check the cap, then validate, then commit.
  - Add a test: a stored op that is invalid or over the cap settles to one rejection with no reconnect loop.

**B2. Step 5 assumes v2 forces reconnects. On celld it doesn't.**
- What happens: a celld deploy moves a resident cell to the new code and **keeps hibernatable WebSockets** (`celld/docs/README.md` ~L255). Void uses `acceptWebSocket`. So an open v1 browser page keeps its socket, and its next message runs in v2's `onMessage`. v2 events then go to v1 browser JS, which does `JSON.parse` with no validation.
- The plan's "reconnect retrieves current state" tests the wrong path, and "route pause" is not the important difference here.
- Change step 5 to:
  - Assert that one already-open socket sends an op that v2 code handles. Tag the reply with the release so the test can tell.
  - Wire contract: v2 accepts every v1 client message and every op stored by v1. v1 pages ignore unknown fields and types in v2 server events. v2 reads attachments written by v1.
  - Note that open sockets can mutate state while HTTP routing is paused during activation. That is fine because the checklist doesn't use D1. Say so.
  - Record the SSE contrast in the same step. A `void/live` stream is a running request, so celld cancels it after `CELLD_DEPLOY_MAX_AGE_S` (default 60). WebSocket survives the deploy and SSE does not. That is a useful finding about what developers will see.

**B3. The idle and hibernation step names a boundary that doesn't exist.**
- What happens: fogd sets no `CELLD_IDLE_EVICT_S` and `CELLD_MAX_RESIDENT_CELLS=100` (compose files, k8s workloads). A one-room fixture therefore never hibernates. The "configured runtime idle boundary" in step 4 has no defined value.
- Consequence: the path the plan cites as "native hibernation" never runs. That path is: the constructor runs again, `getStoredConnection` reads the attachment, and `ctx.request` is a placeholder.
- Change, pick one:
  - (a) Claim no hibernation. Run the idle observation for a stated length and list the timeouts that actually apply: workerd ingress, celld, browser.
  - (b) Add one test fleet with a small `CELLD_IDLE_EVICT_S`. Show that an op after a wake applies once. Record whether rebalancing moves the hibernated room. Moves close sockets with 1012 (README ~L410), which is another reconnect cause.
  - I'd pick (a) now and (b) only if the docs will claim hibernation.

**B4. The SSE item has no authoritative snapshot source and could block acks.**
- What happens: `void/live` stores nothing ("at most once", `docs/guide/live.md:176`). Its connection and topic Durable Objects are separate from the room. If the room's `onMessage` awaits `live.publish` before acking, the ack waits on a call to another Durable Object, possibly on another node. If that call throws, B1's loop starts.
- Change:
  - Publish only after the ack is sent, best effort, catching errors.
  - The event carries just `{revision}` as a hint.
  - A watcher that sees a gap or reconnects fetches the snapshot with `GET` on the room path. That is served by the room's `onRequest` hook, so it comes from the same storage, without adding an event log.
  - This also matches the "watch progress" half of U8.

## Should-fix (cheap)

- **Kill both node roles.** The gateway picks A or B round-robin, and a non-owner tunnels to the owner. Kill the owner and, separately, the entry node that isn't the owner. Their failures differ: celld's ingress sends 1012 when the owner dies (`cloudflare-compat.md:110`), and an entry-node kill drops the TCP connection. Identify the owner right before each kill, because rebalancing or lease expiry can move it. Expect reconnects to fail for up to the lease time (`CELLD_TTL_MS` 10s) or the operation deadline (15s) after an owner kill, and record it.
- **Use synchronous SQL for the transaction.** Use `storage.sql` inside `transactionSync`: the room class is SQLite-backed and celld implements `transactionSync`. With no awaits between reading the receipt and writing, concurrent `onMessage` calls can't interleave, and the vague "transaction retry behavior" item can go.
- **Origin check through the gateway.** `onBeforeConnect` should compare the `Origin` host with `x-forwarded-host`. The gateway strips any client-sent value and sets it from the URL. Don't compare with `request.url`, whose scheme changes behind TLS. Add a negative test through workerd. Decide explicitly what happens to requests with no `Origin` (non-browser clients).
- **Revision watermark after restore.** "Render only nondecreasing revisions" leaves a client stuck if storage ever comes back older. A stopped snapshot won't do that, but a recreated room can. Add a room incarnation ID to snapshots and reset the watermark when it changes. Or state the case is out of scope and have the client show the mismatch rather than stall.
- **Local storage layout.** Store one key per pending op (`pending:<room>:<opId>`), not a shared array. Two tabs in one browser would otherwise lose ops through read-modify-write.
- **Pre-open buffer.** Send from the app only when the socket is open, and resend on `open`. Otherwise `VoidSocket`'s pre-open buffer and the app both resend every op. Receipts make that harmless, but the test results get noisy.
- **Pruning alarms.** They can fire while routing is paused for activation, on either release's code. State that this is acceptable because they only prune subscribers, which is consistent with U7's warning about gating background work.

## Scope

- **Trim:** the retirement sentence in step 7 belongs to U9. Keep the stopped snapshot and fresh-storage restore check for the board and receipts, and drop the retirement claim.
- **Keep:** the two-app check. Gateway host routing for upgrades and "no upgrade before approval" are new paths for WebSockets.
- **Nothing to add.** No heartbeat, backoff policy, or event log is needed for the fixture.
- **DX:** the plan is honest that reconciliation is app code built on native Void APIs. Ship the protocol in the docs as a pattern, not as a fogd helper.
