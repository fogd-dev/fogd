# Preserved-socket update review response

The source review identifies the pre-accept serialization gap in celld, and a
post-accept diagnostic rewrite resolves it on the original binary. The diagnostic
was removed before runtime qualification. The candidate patch caches the encoded
clone and flushes it after accept; an uncloneable value preserves the earlier
attachment. Four focused source-method regressions pass patched source, while
three fail unmodified source. These use a modeled Rust registry seam, not a claim
of exercising the full V8 host.

The unchanged app fails on upstream celld both with a direct deployment update and
with idle eviction followed by an update. Both records show close 1011 and a second
socket. The patched runtime passes the combined case with the original socket,
restored room parameters and a v2 acknowledgment for the retained v1-format record.
Owner/gateway loss, non-owning ingress/control, and browser reconciliation also
pass on the patched runtime. The [public record](../evidence/m11b-patched-runtime.json)
contains the source commit, patch hash, binary digest, image and observed outcomes.

The upstream Docker test stage and Clippy pass. The release tree runs zero Rust
tests, so the functional evidence comes from the source-method and real-runtime
probes. The initial test-stage failure was a full Docker filesystem; only specific
unused fogd image/cache entries were removed. MinIO then enforced its free-space
reserve during deployment; the exact failed approval was retried after reclaiming
the completed compiler cache. No volume or signature check was bypassed.

Final review approves the bounded slice. Its shared-image concern is addressed by
`FOGD_RUNTIME_IMAGE`, documented alongside the celld choice so a patched build need
not retag another installation's default image. The candidate image carries source
and patch labels. Shell override precedence and Docker-only scope are documented.
The same unchanged app has two distinct unpatched negative controls.

Route pause/new upgrades, SSE, actual room moves and stopped recovery remain open.
The separate close-code-1001 dispatch mismatch, attachment-size cap and fresh-copy
semantics are not fixed by this patch. Nothing is published or submitted upstream.
