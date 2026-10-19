# celld attachment serialization before accept

The pinned upstream celld 0.6.2 loses native Void room parameters across handler
replacement when the socket attachment was serialized before `acceptWebSocket`.
The [candidate patch](../../patches/celld-0.6.2-preaccept-attachment.patch) retains
those encoded bytes until acceptance. It is an unsubmitted upstream candidate;
the default fogd image remains the pinned upstream release.

Void's `ws-server.ts` serializes the connection before accepting the socket.
celld's `op_ws_attachment_set` writes only an existing Rust registry entry, while
`op_ws_accept` creates that entry later. The original JS socket can hide the
missing registry bytes until an isolate replacement. The new handler then gets
empty route parameters and closes with 1011. A diagnostic post-accept rewrite
resolved the failure, but no such app workaround is retained.

The patch caches the encoded clone at serialize time and writes those bytes after
accept. A later mutation of the input object does not alter the saved snapshot.
Encoding happens before replacing the prior value, so an uncloneable value leaves
the last valid attachment intact. The cache adds a copy of the bytes in JS.
Attachment-size limits and fresh-copy semantics of `deserializeAttachment` remain
separate celld gaps; this patch does not qualify them. Process loss still closes
sockets and requires application reconciliation.

## Build a local candidate

Use a fresh source directory under this repository. The tested profile is `lab`;
this is functional qualification, not a release-performance claim.

```sh
git clone https://github.com/denoland/celld.git .fogd/celld-preaccept-source
git -C .fogd/celld-preaccept-source checkout 90b43017241f81189453d326d05948f388b34652
git -C .fogd/celld-preaccept-source apply "$PWD/patches/celld-0.6.2-preaccept-attachment.patch"
node scripts/celld-attachment-regression.mjs .fogd/celld-preaccept-source/crates/celld/js/harness.js
docker build --target test --build-arg CELLD_PROFILE=lab \
  -t fogd-celld-tested:local .fogd/celld-preaccept-source
docker build -f docker/celld-patched.Dockerfile -t fogd-celld:preaccept .
```

For Docker installations, set `FOGD_CELLD_IMAGE=fogd-celld:preaccept` and a distinct
`FOGD_RUNTIME_IMAGE=fogd-runtime:preaccept` in the installation's `.env` before
`fogd up`. The separate runtime tag avoids retagging the image used by another
installation on this Docker host. Compose passes the celld choice into that build.
Shell exports override `.env`; check both when selecting the image. Kubernetes
image building does not consume this Docker option and is not qualified here. Unsetting it
returns future builds to the pinned upstream image; existing processes need a
normal stack update to change binaries. Use a disposable installation for this
candidate while the remaining M11b gates are open.

The source-method regression executes the actual upstream methods with a modeled
host registry. It fails three pre-accept cases on unmodified source and passes all
four cases with the patch. The upstream Docker test stage and Clippy pass, but this
published release tree contains zero Rust tests. Real deployment-update probes
remain the functional oracle. Review findings and source references are in the
[diagnosis](../reviews/m11b-update-attachment-claude.md) and
[patch review](../reviews/m11b-preaccept-patch-claude.md).


The [qualified Docker record](../evidence/m11b-patched-runtime.json) pairs both
unpatched negative controls with the patched update-after-idle run and the existing
failure/browser regressions. It includes the binary digest computed from the
recorded immutable runtime image. Keep the patched image available for recovery;
its local tag is not a remotely published artifact. The remaining M11b gates are
still open.
