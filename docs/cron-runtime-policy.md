# Experimental cron runtime policy

Cron commands and bootstrap require explicit runtime identity verification.
Missing verification refuses the operation. Ordinary cron admission remains
closed, and the default backend does not install a cron transport.

The [signed release-profile receipt](evidence/m11c-runtime-binding.json)
qualifies caller checks on an app-free two-node Docker fleet. It covers refusals
before CLI calls, guarded bootstrap, complete live leases and an empty held cron
cell. The separate [sealed recovery](cron-sealed-recovery.md) and
[activation interruption](cron-sealed-activation.md) profiles qualify their bounded
application scenarios on this binary. The [schema 1 receipt](evidence/m11c-runtime-policy.json) is historical.

## Explicit composition

`backendCronRuntime` in the [backend adapter](../packages/platform/src/backend-runtime-identity.mjs)
composes the [identity policy](../packages/platform/src/runtime-identity.mjs) with
`CronRuntime`. A private qualification caller supplies its expected profile:

```js
backend.crons = backendCronRuntime(backend, profile);
```

The schema 2 profile declares an independently checked binary digest, bucket,
storage endpoint and region, plus fleet IDs, prefixes and native node identities.
See the [native guard fixture](../scripts/cron-probe/identity/guard-controller.mjs)
for an executable example. Fleet hosts and prefixes must match the selected slot.
The profile is copied when the policy is constructed. `Backend` copies and freezes
its environment at construction; configuration changes require a new instance.
The S3 client and native CLI use the copied endpoint, region and credentials.
Other AWS SDK options can still depend on ambient environment configuration;
they are outside this binding profile.

A supplied profile expresses caller policy. It does not certify a binary or make
it eligible for ordinary admission. The adapter expects the opt-in
[signed identity listener](patches/celld-runtime-binding.md) on each node's private
port 8082. The controller reads and executes the same absolute native CLI path.

## Bootstrap and command checks

Every cron command, including status and confirmation reads, checks the CLI
digest and challenges every expected node with a fresh random nonce. Exact signed
claims must match the binary, node, normalized namespace and canonical storage
origin/region. The controller's own bucket, origin and region must match its
profile. Schema 1 responses fail.

Membership is inventoried before and after the identity reads. Every expected
node must have a lease whose key, node identity, advertised address and public key
match the expected topology and signed response. Commands require complete leases
with expiry later than the controller clock in both passes. Unknown leases are
refused even if expired. A changed member or key refuses verification; ordinary
expiry renewal is allowed. Freshness depends on agreement between node and controller clocks and on the
lease TTL. A controller clock ahead can refuse a live lease; a clock behind can
accept an expired one. The check is an observation before use, so a lease can also
expire before dispatch. A stale key causes refusal until the new native process
renews its lease.

App-free bootstrap uses a separate check that permits absent leases. Every lease
present must still have the expected identity and signed key. Bootstrap verifies
before reading the artifact or publishing its placeholder configuration. This
self-asserted startup check permits the placeholder deployment needed to establish
normal membership; it does not authorize scheduled handlers. Bootstrap never
falls back to the command verifier, and cron commands never use the looser
bootstrap check.

Each inventory pass and identity request has a five-second deadline and bounded
bodies. Verification can span roughly fifteen seconds plus local hashing.
Truncated inventories fail. Policy errors omit remote diagnostics and credential
values. `CRON_RUNTIME_UNVERIFIED` means refusal before command dispatch. Failed
confirmation verification after a mutation produces `CRON_OUTCOME_UNKNOWN` without
retry. Snapshot checks retain `CRON_SNAPSHOT_UNCONFIRMED` when identity fails.

## Native evidence

The [driver](../scripts/cron-runtime-guard.mjs) requires a new private output
directory, checked native image, observer image and independently verified binary
digest. Its refusal cases cover CLI, node, namespace, older process, another real
S3 origin, an expired foreign lease and a forged known authority. The last case
puts node b's genuine public key into node a's lease using conditional creation.
Pre-bootstrap command refusals establish no CLI dispatch; absent leases already
force those refusals. Bootstrap refusals isolate the individual identity claims.
The same intact app-free fleet refuses a command with absent leases but passes
bootstrap verification, isolating the phase distinction.

The successful path publishes a placeholder, adopts it on both nodes and verifies
held empty status, pause and refusal to resume an empty schedule. Actual leases
are complete, live and matched to signed responses. The receipt independently
checks the native signatures, nonempty unchanged inventories during refusals,
unchanged contents of the second S3 server throughout, matching image sources and
retained volumes after container/network removal. Inspect raw evidence and the
actual runner exit before accepting its printed pass.

## Qualification still required

These observations are not an atomic fence. Runtime or CLI replacement between
verification and use, and new membership after inspection, require a lifecycle
boundary. The signature's relay, host-access and storage-account limits are
specified in the [native binding guide](patches/celld-runtime-binding.md).
Startup and restore must validate images and topology before active timers boot.
A shipped qualified-runtime registry, scheduled application lifecycle on this
release binary and ordinary scoped admission remain open [M11c gates](m11c.md).

Historical receipts identify their executed source versions. Reproduce those
profiles with their pinned sources; they do not qualify the current guarded path
or transfer application lifecycle evidence to the new native binary.

The [host preboot foundation](cron-runtime-preboot.md) adds independent image and
launch checks for experimental restore, with app-free read-only startup evidence.
The separate [sealed recovery profile](cron-sealed-recovery.md) qualifies restored
schedules in its two-fleet scope. [Guarded activation](cron-sealed-activation.md)
qualifies selected controller interruptions; the full runtime lifecycle remains
open. Normal CLI restore and retirement refuse all scheduled history until a
qualified policy is available.
