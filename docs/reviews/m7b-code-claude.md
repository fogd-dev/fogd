# Claude M7b implementation review

**Verdict: no blockers.** Every accepted change is present in the code and I could not construct a data-loss or security failure inside the stated fixture constraints (exclusive operator, no background writers, ingress stopped). Below are the small items worth fixing, then notes and verified points.

## Should fix (small, before merge)

1. **Export over the row cap surfaces as an unhandled ZodError.** `exportSnapshot` selects `limit(101)` and feeds the rows to `validateSnapshot`, whose `.max(100)` throws out of the middleware with no catch (`examples/guestbook/updates/attachments/src/transfer.ts:17`, `middleware/transfer.ts:8`). The operator gets whatever Void does with an uncaught middleware error, not a bounded-profile message. Mirror the import path: catch and return a 409 naming the limit. Same for the misleading "Missing message" when attachments reference message 101+.

2. **A stale claim has no documented recovery.** Once `transfer_state` holds a `pending` or `complete` row for digest A, any other snapshot is refused forever with "Destination belongs to another restore" (`src/transfer.ts:23`). That is correct by design, but the failure text in `scripts/guestbook-transfer.mjs:29` says "retry the same snapshot" and nothing tells the operator how to reset a destination they intentionally abandon (delete the `transfer_state` row and the `attachments/*` objects, or redeploy a fresh app). One sentence in the failure message or docs/m7b.md closes it.

3. **Completion marker relies on an UPDATE that can affect zero rows.** The final batch does `update transferState set complete` then inserts (`src/transfer.ts:55-59`). If the claim row is absent at that point (only reachable by manual tampering between claim and batch), the batch commits rows with no completion record, and every retry then fails "Restore requires an empty destination". Cheap hardening: make the marker an `insert ... onConflictDoUpdate` so the batch itself asserts the claim, or run the claim and the batch in one request path without a gap. Note-level given the fixture, but it is the one state the spec says must not exist.

## Notes, not required

- **Pre-restore orphan on the destination blocks the first restore.** With no receipt, any object in the bucket refuses the restore (`src/transfer.ts:31`). A failed UI upload on the empty target before maintenance leaves an orphan and the error message says the bucket is not empty. Acceptable for "restore only into an empty destination", just know it is a hard stop with no in-band override.
- **Service names are derived as `${slot}-a` and `${slot}-b`** in `scripts/guestbook-transfer.mjs:17`, while compose allows host overrides per slot. Fine for the fixture.
- **`compose stop` is graceful here.** compose.yaml sets `stop_grace_period: 45s` and the scripts never pass `-t 0`, so celld's `quiesce_and_seal_within` runs for both replicas. Confirmed, no change needed.
- **Readiness budget.** `Backend.ready` shares one 180s deadline across both nodes and `privateRequest` kills at 210s, so the outer timer cannot preempt a legitimate wait. Fine.

## Verified against source

- **Resource floor:** `app.resources` is cloned and saved at `step('approved')` before any publish or migrate (`controller.mjs:130-131`). Compatibility is checked before `claim()` and again after reconcile, and the displayed diff is against the active release (`controller.mjs:65`). Rejection of a failed release keeps the floor. Both new platform tests exercise these paths.
- **Preflight matches celld.** `valid_resource_name` in deploy.rs allows alnum, `_`, `-` and 64 chars. App names are `[a-z0-9-]` and bindings `[A-Za-z0-9_]`, so the derived names can only fail on length, which `validateStorage` now checks for both D1 and R2. Nested keys like `jurisdiction` are rejected.
- **D1 batch is one transaction.** celld storage.rs documents `Batch` as "prepared statements in one transaction", and the smoke script's trigger-abort case asserts the partial export is empty.
- **Public barrier.** Gateway returns 404 for `/__fogd` after percent-decoding and strips every `x-fogd-*` header. The middleware requires the header and exact path. Case variants and `//` fall through to normal routing and 404.
- **Download hardening.** Fixed octet-stream content type, fixed filename, nosniff. Upload stores octet-stream and caps name length. No stored-XSS path through attachments.
- **Profile validation.** Canonical base64 round-trip, per-object sha256 recomputed on both export and import, duplicate IDs, missing references, strict schemas, and the 100/64KiB/1MiB/2MiB bounds all enforced in `validateSnapshot`. Message schema matches the existing `messages` table exactly, including the 1000-char text cap already enforced by the page action.
- **Retry semantics.** Pending claim with the same digest re-verifies existing object size and hash before proceeding; a different digest is refused; a complete claim returns `alreadyRestored`.

## Future scope (outside M7b)

Per-key SHA-256 R2 keys, a controller-level ingress pause instead of stopping `workerd` for every app, and automatic R2 orphan sweep on the destination all belong to M8 or later, as the spec already says.
