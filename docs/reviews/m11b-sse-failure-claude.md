# Claude review: SSE failure qualification

No blockers in `scripts/live-sse-isolation.mjs`, and its PASS claim is honest for its stated scope. The publication-stall plan has four blockers. The biggest is that a paused node loses its celld lease after about 10s, and from then on the result depends on timing. I also have a simpler setup to suggest.

## Isolation script

The check is sound for what it claims. A cross-app leak would fail it: each watcher's final hint list must be exactly `[1..n]`, there must be one `open` and zero `error` events, and the snapshot text must match each app's own edits.

Gaps worth noting (none block the claim):
- **Behaviour only.** It shows that two apps using the same stream id don't see each other's hints, but it doesn't show why. The reason is in `engine_api.rs`: `namespace_key` puts the script name into the namespace (`cells:v1:{len}:{script}:{class}`). Recording the two distinct topic residents from `/state` would turn that into runtime proof. Optional.
- **Unchecked fields.** It never asserts `subscriptionId === 'board'` or `topic === room` on events. That's cheap to add.
- **Narrow error capture.** Only `pageerror` is captured, not console errors or failed requests. Also, nothing is saved when it fails, so a failure leaves no evidence to debug from.

## Stall plan: placement assumption

The assumption holds on an idle fixture. celld claims a fresh cell on the node the request arrives at. It only asks capacity peers when that node is full (`logic/lib.rs:4260`). So "topic follows ingress" is right, provided nothing publishes before the subscribe. Step 1's "no mutations" rule protects that, because a publish from the board would create the topic on the owner.

The ID derivation is reproducible:
- name: `live:checklist-hints:topic:<topicDigest(streamId, room)>` (`live-names.ts`)
- id: two HMAC rounds keyed by the SHA-256 of `namespace_key(script, VoidLiveStreamDurableObject)`

The connection and topic objects are the same class, `VoidLiveStreamDurableObject`. Add a positive control: run the same derivation on the board's own name and require it to reproduce the known `ChecklistWs:` resident. If it can't, stop.

## Blockers

1. **The lease expires during the pause.** `CELLD_TTL_MS` defaults to 10s (`machine.rs:101`). Check what the fixture sets.
   - A paused node stops renewing its lease. Once it expires, the owner can take over the topic and connection cells. A later edit's publish may then succeed locally and log nothing, or wait on takeover and node-log recovery.
   - Fix:
     - Do both edits well inside the lease window and record how long after the pause each happened.
     - Read topic residency and epoch right before the pause and again after the unpause.
     - In step 5, don't assert the topology is "restored". The topic may legitimately have moved, so record where it ended up.

2. **Log lines can't be matched to edits, and late delivery is possible.**
   - `publishHint` logs `Checklist hint ${outcome}` without a revision, so two edits produce lines you can't tell apart. Add the revision to the warn line in the example app. That's a log-only change, not fault injection.
   - `Promise.race` doesn't cancel the publish. The fetch that hung against the paused peer may finish when the node resumes, so stale hints can arrive late.
   - The evidence must say whether recovery came from a late hint, a native resubscribe, or the fresh edit in step 5.

3. **A log line alone could give a false pass.** Also require:
   - the watcher's hint list is unchanged during the pause;
   - the writer socket didn't close;
   - the topic was resident on the paused node at the moment of the pause.

   Re-check residency immediately before pausing, the way `live-route-pause.mjs` does, not only during setup.

4. **A visible reload in step 5 hides a stuck observer.** Reloading always fetches a fresh snapshot, so it would pass even if native recovery is broken. If a reload is needed, record it as native recovery failing and keep item 6 open. Only native retry or `observer.refresh` should count.

## A design issue that also points to a simpler mechanism

`connectionId` is created once per client (`live-client.ts:61`) and reused on every reconnect. So after step 3 the watcher's SSE goes in through the owner but is still served by the connection object on the other node.

Pausing that node therefore freezes the watcher's stream as well as the topic. That mixes up "publication stalled" with "observer transport frozen". Step 3 would also need to re-assert that the connection is still on the other node.

**Simpler setup (recommended):**
- Leave the gateway alone. Create the board through the normal path.
- Create the topic on the other node with a direct subscriber run inside the controller against `http://<other>:8080/live`. `live-ingress.mjs` already does this with `live-control.mjs` for room sockets.
- Point the browser watcher through workerd at the owner. Its connection object lands on the owner and registers with the topic that already exists on the other node.
- Pause the other node. The watcher stays live (Void sends a keep-alive every 15s), so the only thing that stalls is publication.

This drops both workerd recreations and both setup reconnects. The fault becomes "the topic owner is frozen", with nothing else frozen. If the default gateway order picks the wrong node for the board, you only need one routing override.

## Cleanup

- Order the `finally` the way `live-route-pause` does: unpause first, then remove the override, then recreate workerd. Never recreate workerd while a node is paused.
- Finish by checking `docker inspect .State.Paused == false` on every node and waiting for celld health, as `live-ingress` does.
- `finally` doesn't run on SIGINT or SIGKILL, so an interrupted run leaves the node paused. Add a SIGINT/SIGTERM handler, or record the manual `compose unpause` command in the evidence file.
- If board commits block while the node is paused, record the gap and stop. Your plan already says this; keep it, and don't let a retry path turn it into a pass.

## Evidence limitations (not blockers)

- **Backlog may not be drained.** A paused container's network stack keeps accepting TCP connections, so requests hang rather than fail. You'll most likely see `timed-out`, not `failed`, and only that branch of `publishHint` gets exercised. The peer connect timeout (3s) doesn't apply because the connection succeeds. Unpausing can release a backlog of in-flight requests that finish later than the evidence window.
- **No latency SLA**, as you already planned.

Is the fault meaningful? Yes, once blockers 1–3 are fixed. It tests the one real path here: a durable ack must not wait on a publish to a different node.
