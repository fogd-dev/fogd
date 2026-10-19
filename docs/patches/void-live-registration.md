# Void live registration candidate

fogd applies a version-pinned Void server patch so a delivery during subscription
registration does not delete a subscription that subsequently reports success.
It is included in [the pnpm patch](../../patches/void@1.1.11.patch), alongside
`sendIfOpen`. The [upstream source patch](../../patches/void-1.1.11-live-registration.patch)
targets Void 1.1.11 at commit `6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f`.
No upstream acceptance or package publication is implied.

## Failure and correction

Void stores the topic's subscriber row before the connection has recorded its local
subscription. A delivery or prune check in that interval sees the row as stale and
deletes it. Registration can then report success while later notifications are
lost. The source-level reproducer confirms this with actual upstream methods and
modelled storage and transport; a browser happy path does not exercise that race.

The candidate tracks pending registrations explicitly, reserves a unique revision
before yielding, and accepts a matching pending row during delivery and pruning.
A response cannot install a registration overtaken by unsubscribe, reconnect,
close, or a newer registration. Connection limits include pending ids. Topic
registrations are serialized across outbound capacity checks, so competing requests
cannot both claim one free slot. Publication and unregister operations use their
existing paths. At a full topic, concurrent registrations queue behind stale scans,
which can increase reconnect latency. Strict stale detection remains in place for other rows.

After a control error, server state for the affected id is uncertain: resubscribe
or unsubscribe. A registration can commit remotely before its reply is lost.
Native Void's local rollback does not prove the prior server subscription survived.
The checklist observer displays `Not subscribed` and offers an explicit reload.
For concurrent raw control requests on one id, the most recently started request
wins; if it fails, the id may be unsubscribed. Native Void serializes its own control
flushes. This patch does not add a transaction protocol across objects.

## Verification

The workspace test command executes twelve cases against the installed JavaScript
file and prints its resolved path. They cover delivery during registration,
resubscription, failed replacement, reversed arrival order, overlapping topics,
unsubscribe and cleanup failure, reconnect/close, pending capacity, ambiguous reply
loss and retry, delayed cleanup, overlapping topic capacity checks, and independent publication
and unsubscribe while registration is held. The test also imports the installed
module without substituting its dependencies.

```sh
pnpm install --frozen-lockfile
node --test scripts/void-live-probe/registration.test.mjs
```

To run those cases against a patched source checkout:

```sh
FOGD_VOID_LIVE_SOURCE=.upstream/void/packages/void/src/runtime/live-server.ts \
  node --test scripts/void-live-probe/registration.test.mjs
```

The upstream live-server suite passes 25 tests. Its package typecheck and full lint
also pass after building its workspace dependencies. The fogd browser test verifies
SSE cancellation/reconnection across actual approval and a later edit. These do not
prove every possible runtime scheduling interleaving or generalized alarm behavior.
SSE publication-failure and cross-app isolation qualification remain separate work.

## Regenerate the installed-file patch

Apply the source patch to the pinned upstream checkout, then extract the package
with `pnpm patch`. The generator uses the repository's pinned Vite/OXC and preserves
the package's original runtime import specifiers. It checks the pinned Git revision,
source diff, and imported helper names before writing. It changes only live-server.mjs;
`pnpm patch-commit` retains the existing WebSocket patch in the same patch file.

```sh
git -C .upstream/void apply "$PWD/patches/void-1.1.11-live-registration.patch"
pnpm patch void@1.1.11 --edit-dir .fogd/void-live-edit
node scripts/patch-void-live.mjs \
  .upstream/void/packages/void/src/runtime/live-server.ts .fogd/void-live-edit
pnpm patch-commit .fogd/void-live-edit
pnpm test
```

Start with an unmodified checkout of the pinned source for `git apply`. The source
patch is an upstream artifact, not a second pnpm patch. New Void versions require
reviewing the source and package import layout again.
