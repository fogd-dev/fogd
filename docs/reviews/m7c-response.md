# M7c specification review response

The [original spec](../m7c.md) is retained. Claude's [review](m7c-claude.md)
identified required clarifications and validation gaps.

- The fixture declares BETTER_AUTH_SECRET with a non-optional `env.ts` schema.
  fogd does not set `VOID_CLOUDFLARE_DEPLOY_BUILD`: it also changes upstream
  version-metadata behavior. Only emitted required names are admitted. Auth apps
  must explicitly declare this name; optional/defaulted env entries are not secret
  injection declarations. This is a bounded qualified app pattern, not automatic
  inference of every possible auth configuration.
- Strip the upstream secrets declaration from celld config. Preserve only names in
  digest-covered fogd metadata, validate its allowed keys/conflicts on receipt, and
  reject plaintext-var collisions. Allow only prebuilt `build.watch_dir` metadata;
  do not execute or accept build-command directives from an artifact.
- Secret mutation uses a 64 KiB HTTP cap and fixed JSON errors. CLI input is UTF-8
  stdin; neither arguments nor output contain values. Values have separate per-key
  and aggregate limits. The mutation queue serializes secret changes and approval.
- Approval sends `{digest, secretRevision}`. The UI displays the exact revision;
  CLI approval requires the revision argument when a release declares secrets.
  Retries retain their pinned revision, even after the current set changes.
- Validate names/presence before side effects. After publication, call native
  `/__void/ready` privately on both replicas to run Void's env schema validation.
  Invalid configuration leaves routing paused with a fixed diagnostic and stage.
- The admin supplies a signing secret of at least 32 characters, validated by the
  fixture's schema. Rotation is a new approved deployment and invalidates existing
  sessions. The browser smoke tests that outcome.
- Do not copy raw backend errors into controller logs for secret-bearing apps.
  That would introduce another disclosure surface. Fixed stage diagnostics sacrifice
  detail; operators can inspect their private runtime/storage and reviewed code.
  This applies to later releases of an app that has used private configuration,
  even if those later releases remove every secret declaration.

## Password runtime finding

celld's pinned `js/node_crypto.js` implements `scrypt` and `scryptSync` as
`notImplemented`. Void defaults to Node scrypt with N=16384, r=16, p=1, a 64-byte
key, a random 16-byte salt encoded as hex, NFKC password normalization, and a
`salt:key` record. The fixture supplies a clearly labeled `auth.ts` password adapter
using `@noble/hashes` scrypt with those same inputs and format. Node-native
interoperability tests cover both verification directions and wrong passwords.
Native Void still owns accounts, sessions, cookies, routes, and migrations.

This changes the original spec's default-password implementation requirement.
The upstream celld gap remains explicit; no cost parameter is reduced. The adapter
also builds for the ordinary Void target and is removable once upstream scrypt
support is qualified. No runtime fork or authentication protocol is introduced.

## Second review and implementation qualification

Gemini's [spec review](m7c-gemini.md) found a real pre-activation gap: selection
was validated before slot claim, but persisted only afterward. Approval now saves
the pinned revision before claim or reconciliation. A failed preparation records
its stage, withholds private backend diagnostics, and retains the revision across
restart. A fault-injection test verifies persistence inside the failing claim and
rejects a rotated revision on retry.

Other accepted corrections: reject a supplied revision when no secrets are declared;
show no revision for that case in the admin UI; require canonical nonempty metadata
when its file is present; reject reserved prefixes case-insensitively; filter inherited
Void managed-deployment flags from local builds; preserve constant-time CSRF checks;
and enforce private directory permissions even when the directory already exists.
Private celld version hashes stay in controller storage for recovery, but are omitted
from admin API responses because those hashes cover injected values.

Several findings described an earlier or incorrect file state. `saveJson` already
creates files with mode 0600; `.dockerignore` already excludes env/build output;
and the offline verification script already includes accounts. The script now also
asserts the staged required-secret declaration. Void's shared password implementation
uses async Node scrypt; both async and sync primitives are unsupported by the pinned
celld shim. The explicit adapter amendment above supersedes the original default-
password requirement. No blanket build-mode flag or internal proxy token is injected.

Gemini's [implementation review](m7c-code-gemini.md) reported no blockers. Review
responses are evidence, not a substitute for the browser and failure-injection tests.

Claude's [implementation review](m7c-code-claude.md) also reported no blockers.
Its constant-time CSRF correction is included. The selected secret revision is now
visible outside collapsed details, with pinned retries labeled. Its readiness retry
suggestion is deferred: the private probe has a bounded timeout and fails closed;
operators explicitly retry slow starts. No readiness failure was observed in the
qualified browser runs. Both implementation reviews inspected the work in progress;
the final preparation-pin fix is additionally covered by the targeted restart test.
