# Claude registration race patch review

I'd go with **C, with two changes**: revisions come from a counter that only goes up, and a registration only takes effect when it settles if it is still the latest. **A** brings back the failed-replacement hole it is meant to fix. **B** removes the cleanup path the protocol relies on. I read `live-server.ts` (void 1.1.11, upstream `6ef71cf`), the regression script and its log, `live-client.ts` and the uncommitted observer wiring. I implemented and ran nothing.

## Confirming the race

`control()` waits on `/register` (`live-server.ts:270`) before it touches `connection.subscriptions` (`:296`). If a `/deliver` or `/check` arrives in that window, `isStaleSubscriber` (`:603`) finds no subscription, or an older revision, and reports the row stale. The topic object then deletes it (`:478`, `:535`). That matches `.fogd/m11b-sse-registration-negative2.log`: accepted, `rowsDuringRegister: 0`, `received: []`.

The same window opens in four other places, and the patch must cover all of them:
- **Resubscribe (rev N to N+1):** the local copy still holds rev N, so the new row is "stale".
- **Capacity check during another register:** `register()` calls `findStaleSubscriberKeys` (`:391`), which sends `/check` back to this same connection object. Any other subscription still registering gets evicted.
- **Repeated revision (existing bug):** two overlapping subscribes for one id both compute `existing.revision + 1` (`:259`). They write the same storage key, and the second to finish deletes it via `unregisterTopic(existing)` (`:292`). The subscription stays active with no row.
- **Reconnect while registering (existing bug):** a same-owner reconnect reuses the same `subscriptions` Map (`:184`). A late settle from the old connection writes an active entry with the old generation into the new connection's map. It uses up subscription-limit slots and nothing ever unregisters it.

## A: install first, restore on error

**Rejected as specified.** While the new entry is installed, a delivery of the *previous* revision's row fails the revision check, so the topic deletes it. If registration then fails (409 topic full, or the fetch throws) and A restores the previous entry, it looks active but has no row. Hints are lost silently. Today that case works, because `register()` returns 409 before deleting anything.

A's identity and generation guards are still needed. They just belong inside C.

## B: treat "unknown" as not stale

**Rejected.** Strict stale detection is the only way leftover rows get cleaned up:
- unregister failures are swallowed (`:292`);
- an unsubscribe whose unregister throws leaves an inactive entry behind;
- a register that succeeds on the topic but whose fetch throws leaves a row with no owner.

All of these are collected by the next deliver, check or alarm. B keeps those rows for as long as the connection is open and changes cleanup semantics. I agree with your own assessment of it.

## Recommended patch: C with a counter and a settle guard

Everything is in `live-server.ts`:

1. **New connection fields.** Add `pending: Map<string, ActiveSubscription>`, keyed `${id}:${revision}`. Take revisions from a counter on the object instance that only increases. Generation is already part of the storage key, so the counter needs no persistence. This removes the repeated-revision bug.
2. **`isStaleSubscriber`.** Generation mismatch means stale. Otherwise, a row matching `pending` is not stale, and every other case keeps today's strict logic.
3. **Subscribe:**
   - Before awaiting, mark any pending entry for the same id inactive, so the most recently started request wins.
   - Add the new entry to `pending` and call `/register` inside `try/finally`, removing it from `pending` in the `finally`.
   - Settle the entry only if `this.connection === connection`, the entry is still active, and the current entry's revision is not higher.
   - If it has been overtaken, unregister its own key best-effort and leave the map alone.
   - Otherwise, read `existing` again *after* the await, set the new entry, and unregister `existing` best-effort.
4. **Unsubscribe.** Also mark that id's pending entries inactive. Delete the local entry first, then unregister with `.catch(() => {})`. If the topic can't be reached, the row now reads as stale and the next delivery removes it. Today the whole batch fails with a 500.
5. **`connect()`.** Mark `previous.pending` entries inactive alongside `previous.subscriptions` (`:168`).
6. **Topic `register()` (`:381`).** Only delete rows for the same subscription with a *lower* revision or an older generation. If a higher revision already exists, return ok without writing. Without this, two same-topic subscribes that reach the topic in reverse order leave the newer one with no row.

**What C still allows:** during registration, the connection can send events for a subscription that has not been confirmed yet. That is harmless here. The client drops unknown ids and topic mismatches (`live-client.ts:207-211`), and your observer ignores hints until `registered` and then reads a fresh snapshot.

## Tests required

Add these to `test/unit/live-server.test.ts`. They should use the real `createLiveDurableObject`, as the existing tests do, with a `/register` reply that is held open:

1. **Initial subscribe:** publish during registration. The row survives and a later publish is delivered. This is your script, moved in.
2. **Resubscribe, same id and topic:** publish during registration. The rev N+1 row survives.
3. **Failed registration (409, and a thrown fetch):** publish during the window. The previous subscription keeps its row and keeps receiving, and `pending` is empty afterwards.
4. **Overlapping subscribes for one id, same topic:** arrival order is the reverse of start order. The newest wins and exactly one row remains.
5. **Overlapping subscribes for one id, different topics:** the losing row is unregistered.
6. **Unsubscribe while a subscribe is pending:** nothing is current afterwards and the row is gone. A variant where unregister fails shows the next publish pruning it.
7. **Reconnect, and separately close, while pending:** nothing is installed into the new map, the limit count is unchanged, and the old row is removed or pruned.
8. **Pending row under pressure:** a `/check` from the alarm, and a capacity check triggered by another subscription's register, both leave the pending row in place.

Label it as a version-pinned patch: `void@1.1.11` / `6ef71cf`, `runtime/live-server.ts` only, no client changes, so native Void DX is unchanged.

## Observer wiring

Nothing blocks the SSE claim on the observer side once the upstream fix lands. Two small issues:

- **Misleading message during reconnects.** If a reconnect fails to open, the client reports `Error('live: stream failed to open.')` through `onError` (`live-client.ts:180-184`) and keeps retrying. `watch.tsx` maps that `Error` to `failed()`, which shows "Subscription failed. Reload…". It does recover: the next successful resubscribe records the newer epoch and moves to Synchronizing and then Live. Only initial-subscribe failure and control failure should show the reload message; keep "Reconnecting" for open failures that will be retried.
- **Parse errors.** A JSON parse error on a message also reaches `failed()`.

The rest checks out:
- Every EventSource `error` now bumps the epoch, from a listener that runs before the client's handler.
- A control reply from an older epoch is ignored.
- Reload accepts the current state explicitly.
- The hint is fire-and-forget after the peer broadcast, with its failure or timeout logged.
- The snapshot GET sends `no-store`.

The comment on the fire-and-forget hint is honest about cancellation.

Your criterion stands: SSE isn't complete until the source regression passes against the patched source and the native browser run still passes. The browser run alone can't show the race.
