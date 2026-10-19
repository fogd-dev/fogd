# Claude SSE design review

I found three blockers: two in the draft's client code and one race inside upstream `void/live` that the design's refresh strategy can't repair. The rest of the design holds up against the upstream code.

Your working tree already has an uncommitted draft (`pages/watch.tsx`, `lib/observer.mjs`, `lib/hint.mjs`, `routes/live.ts`, `src/live.ts`, `test/observer.test.mjs`, plus a change to `[room].ws.ts`). Where the draft already shows a problem, I point at it.

## What the upstream code confirms

- **Registration is complete when the control response arrives.** `live-server.ts:270-304` waits for the topic `/register` before replying. So refreshing the snapshot after the control response closes the snapshot-before-subscribe race. Not refreshing on EventSource `open` is correct.
- **All subscribes go through `options.fetch`.** The first subscribe and every automatic resubscribe use the same `flush` → `fetchImpl` path (`live-client.ts:268`). Your adapter will see all of them.
- **The SDK owns reconnect.** Its `onError` closes the EventSource and opens a new one itself (`scheduleReconnect`), so the browser's own EventSource reconnect never runs. The `connectionId` stays the same across reconnects, so it can't serve as a generation marker.
- **Anonymous control needs `allowAnonymousControl: true`.** The owner is `null` and the owner check passes `null === null`. Safety rests on the random `connectionId`. Fine for this demo.
- **Hints can arrive out of order.** Publishes are serialized per topic in arrival order, which isn't revision order. Treating each hint as "go refresh", with revision filtering on snapshots, is right.

## Blockers

1. **A subscription can go silently deaf after `ok: true` (upstream race).** The connection object makes an outgoing `/register` call, and a `/deliver` can be handled while it waits. The order of events:
   - The topic object stores the row with the new revision.
   - A publish already in progress sends `/deliver` before the connection object has added the subscription to its own list (`live-server.ts:296`).
   - The stale check (`isStaleSubscriber`) sees no subscription, or the old revision, and marks the row stale.
   - The topic object deletes it (`:475-479`).

   Control still returns `ok: true`. The snapshot after registration covers that one edit, but every later hint is lost until the next reconnect. No client-side revision logic can repair this.
   - Record it as an upstream gap; m11b item 6 says to keep the item open if a separate fix is needed.
   - Fix options upstream: add the subscription to the list as pending before `/register`, or don't treat `row.revision > subscription.revision` as stale.
   - Or as a stated stopgap: a slow background snapshot poll, documented as one.
   - In any case, don't claim "stays live".

2. **The draft has no recovery after a registration failure.** `watch.tsx` maps every `onError` and every `subscribe().catch` to `observer.disconnected()`. That's wrong in three cases:
   - *First open or first subscribe fails:* the SDK rejects, calls `closeIfIdle`, and never retries. The page shows "Reconnecting" forever.
   - *Resubscribe fails on an open connection* (`!response.ok`, `ok:false`, a fetch throw, TOPIC_FULL, or CONNECTION_NOT_FOUND): the SDK only reports it and schedules no retry. `observer.control` returns silently, so the page is stuck too.
   - *`onError` also fires for SDK `Error`s* (a bad message JSON, a resubscribe rejection), not just EventSource disconnects. Those bump the epoch on a healthy connection.

   Fix: put a generation counter on a wrapped `eventSource` constructor (a documented option) and mark stale only on real EventSource `error` Events. Send any registration failure, first or repeat, to a visible "Not subscribed" state with a retry button that runs `client.close()` and builds a new client. That one retry path covers every case.

3. **A stalled publish delays the broadcast to other writers.** In `[room].ws.ts` the draft awaits `publishHint` *before* `ctx.room.broadcast`. The sender's ack isn't delayed, but other writers' WebSocket snapshots wait up to the 1 s deadline. Move the publish after the broadcast.

   Separately, there's no test of whether native Void or celld runs a room's message handlers one at a time. If they do, any awaited deadline delays the *next* operation's ack. The "stall doesn't delay the durable reply" test has to send a second operation from another socket during the stall and check its ack.

## API assumptions to verify (these could become blockers)

- **Does `onBeforeConnect` run for the `onRequest` GET?** It rejects any request without an Origin header, and a same-origin `fetch` GET usually sends none. If it runs for plain HTTP, every observer snapshot read gets a 403. The browser test will show it; check before building on it.
- **Live resource inference from `src/live.ts`.** The live object is defined outside `routes/`, and is reached only through imports from the room and from `routes/live.ts`. Confirm the build output has the `VOID_LIVE` binding and an append-only class migration in `void.lock.json`, and that a redeploy keeps the class.
- **celld's default class (`generation.rs:522-529`).** `default_do_class` is set only when there is exactly one user Durable Object class. Unless the generated live class counts as reserved (`is_reserved_class`), adding it makes two and turns off bare-id `/do/<id>` defaults. That's the exact regression the comment there describes. Check whether fogd or the fixture relies on bare ids for the room.
- **Alarms.** The topic object's prune uses `setAlarm?.`. If celld throws on it, `/register` fails and every subscribe returns INTERNAL_ERROR. Record what actually happens, without a general alarms claim.
- **Deploy cancellation and idle eviction.** `CELLD_DEPLOY_MAX_AGE_S` (default 60) cancels the connection object's stream. Run the cancellation test with a small value. The 15 s keep-alive may or may not stop `CELLD_IDLE_EVICT_S` from evicting the object; record it as a finite observation.

## Advisories

- **Origin checks.** Leaving the Origin check off `GET /live` is correct: same-origin EventSource requests don't send an `Origin` header. Keep the POST check. Optionally reject `Sec-Fetch-Site: cross-site` on the GET.
- **Testability.** Move the adapter wiring out of `watch.tsx` into `observer.mjs`, as one function that returns `{fetch, eventSource, onError}`. Then unit-test the real `connectLiveStream` in Node with a fake EventSource and fake fetch. Today the epoch capture and error mapping are untested; only the model is.
- **Topic check.** Have `control()` check `r.topic === room` as well as the subscription id.
- **Snapshot reads.** One request in flight at a time, plus a dirty flag, makes out-of-order reads impossible by design. Keep the epoch check for reads from older generations. Add `cache-control: no-store` to the `onRequest` GET.
- **Diagnostics.** `publishHint` throws away its `'failed'`/`'timed-out'` result. Log it, since "app errors only diagnostics" needs a diagnostic.
- **Restore while connected.** Inside one generation, lower revisions are dropped silently, so an observer still connected during a restore stays "Live" on stale data. Item 7 stops clients first, but say so in the docs.
- **Event ids.** Don't set `eventId` on hints. The SDK would echo it back as `lastEventId`, which implies a replay that doesn't exist.
- **Topic capacity.** Topics cap at 256 subscribers, and anonymous clients can fill that. Note it as a demo limit.

## Tests still missing

- **`hint.mjs`:** publish rejects, publish never resolves (fake timers), and a synchronous throw from `withEnv` (missing binding).
- **Room ordering:** with a stalled publish, the ack is sent, then the peer broadcast, and a second operation is acked promptly.
- **Failure paths:** first-subscribe failure leads to the retry state, and resubscribe failure leads to the retry state. Neither should stay at "Reconnecting".
- **Isolation:** two apps using the same room name don't receive each other's hints.
- **A real publication failure:** kill the replica that owns the topic or connection object during a publish, using the item 4 kill tooling. Anything short of that, label as a modelled unit test.
- **Blocker 1:** a deterministic reproduction needs an upstream-level test with a delayed `/register` reply. The browser test won't catch it reliably.
