# Upstream candidate: send without VoidSocket buffering

The pinned Void 1.1.11 client buffers messages passed to `send` when the native socket
is not OPEN, then flushes them before emitting its next `open` event. During the
CLOSING-before-close-event window, an app can still believe it is connected. A send
then bypasses app-owned snapshot/reconciliation gating on reconnect.

fogd carries [a version-pinned package patch](../../patches/void@1.1.11.patch) adding
`sendIfOpen(event): boolean`. It returns false unless OPEN, otherwise calls the native
send once and returns true. It never adds to the SDK buffer. Exceptions propagate.
True is not delivery or persistence; the application still needs a server receipt.
Existing `send` behavior is unchanged.

This is an **unsubmitted upstream candidate**, not an upstream-supported API. The
source change belongs next to `VoidSocket.send` in Void's
`packages/void/src/runtime/ws.ts`; the patch changes the published runtime and its
hashed declaration chunk for exactly 1.1.11. A dependency upgrade must reconcile or
remove it. No private SDK fields are read by the application.

pnpm-workspace.yaml records the patch and pnpm-lock.yaml records its hash. Both
Dockerfiles copy patches before frozen installation. The verify image includes the
patched SDK and builds the checklist for both targets with networking disabled.
The runtime image's filtered production install still validates the workspace;
application client code is compiled into its deployment artifact.

The checklist's native-client test covers the CLOSING window, an empty SDK buffer
at open, rollback refusal, explicit retry, and backward-compatible buffered send.
The browser probe closes the actual native socket and submits synchronously in the
same task, delays the next first snapshot, and asserts no operation precedes it.

When moving the example outside this workspace, carry this patch and pnpm's
patchedDependencies configuration, or use an upstream version with the equivalent
API and update the code. An unpatched Void 1.1.11 install cannot run this client's
`sendIfOpen` call. This portability requirement is explicit; no hosted Cloudflare
execution is claimed.
