# Qualify scheduled retirement on the guarded release runtime

The [sealed retirement receipt](evidence/m11c-sealed-retirement.json) covers stopped
retirement, isolated capacity reuse and held restore on local Linux arm64 Docker.
The full and two-cron profiles use the signed release runtime and immutable
qualification programs. Ordinary scoped cron upload, scheduled CLI restore and
scheduled CLI retirement remain closed.

## Run the private profiles

Use the cached runtime, storage and offline SDK images identified in the receipt.
The [runtime binding](patches/celld-runtime-binding.md) and
[preboot guide](cron-runtime-preboot.md) describe their prerequisites. Preserve the
matching native source and private build receipt used to verify default timing.
No dependency installation, Rust rebuild, Cloudflare credentials or hosted
execution is part of these profiles.

Run the [driver](../scripts/cron-sealed-retirement.mjs) from the repository root,
using new private directories. Run the profiles sequentially:

```sh
node scripts/cron-sealed-retirement.mjs .fogd/NEW_SEALED_RETIREMENT
node scripts/cron-sealed-retirement.mjs .fogd/NEW_SEALED_DUAL_RETIREMENT --dual
```

The full profile reserves loopback ports 8958 and 8959 and private networks
`10.252.247.0/24` through `10.252.249.0/24`. The two-cron profile reserves ports 8960
and 8961 and networks `10.252.250.0/24` through `10.252.252.0/24`. Keep those resources
available for the selected run. Both profiles use native schedules and hold each
restored installation for at least 62 VM seconds with its controller stopped,
then for another such interval after acknowledgment and before separate resume.

Private snapshots, controller state, artifacts, credentials and logs stay in ignored
storage. Cleanup removes only the run's containers and networks. The full profile
retains 49 installation volumes, seven validation-failure volumes and one ownership
sentinel volume. The two-cron profile retains 28 installation volumes plus the same
seven-volume failure target and one sentinel volume. Preserve failed attempts.

## Check authority before effects

Each image contains its runtime policy and qualification programs. The fixture
preauthorizes complete fleet inventories, retirement generations, controller launch
modes and both artifact digests before any snapshot exists. The host chooses a
transition from its known source variant. A snapshot supplies state to validate;
it cannot choose its own trusted runtime profile.

Before restore creates target resources, the host verifies the stopped source,
recorded snapshot fingerprint, background recovery evidence and exact retirement
history. The production planner must produce the independently authorized namespace
and node identities. Controller arguments come from that same policy before
preboot. Restored cron controllers match one complete inventory and cross-check its
retired generations against stored state.

The refresh artifact is the exact output of the offline qualification adapter,
checked against an ordinary Void build with networking disabled. The private
[adapter](../scripts/cron-probe/native.mjs) validates cron and secret declarations,
translates the remaining configuration through fogd, and preserves the triggers.
Ordinary artifact staging still rejects cron. The second scheduled artifact
changes only the generated top-level app name to `scheduled-next` before its digest
is pinned. This bounded naming adapter is recorded separately from the original
offline output. Staging checks source and copied artifact digests. Commands select
only the permitted named artifact; they cannot supply executable paths, profiles
or secret values. Required secrets and exact approval still precede activation.

## Interpret the lifecycle evidence

The full profile preserves the [historical retirement oracles](retirement.md#experimental-scheduled-app-retirement):

- Retiring a queued app preserves a cron survivor and real pending queue input.
- Fresh queue capacity accepts an ordinary built and approved replacement without
  inheriting old records or scoped upload authority.
- Retiring a cron with a persisted retry preserves the queued replacement and its
  pending input. A separate source restore compares the complete pre-pause ledger.
- A new scheduled app requires its own secret revision, empty application tables
  and fresh seeded configuration. Native future work succeeds before its retirement.
- Queue-only and zero-live targets start the stock controller after independent
  preboot verification. Retired schedules, private material and source bytes remain
  retained; retired names, credentials, approval and secret writes stay refused.

The two-cron profile retires the original scheduled app while another cron remains
live. Both source schedules share a native due time and are held before that
deadline. The survivor requires separate recovery acknowledgment and resume. A
separate restore of the source archive holds both original schedules and compares
their complete ledgers. Future work must preserve old occurrence rows.

Cold observations use image-only helpers without data mounts. Fresh signed proofs
cover every native replica before controller startup and again after startup.
Independent checks verify the caller nonce, executable, node, storage namespace,
canonical storage origin and region. Native handler, operation and maintenance
defaults remain in force; the profile does not qualify per-worker CPU quotas.

Actual CLI restore and retirement commands must refuse scheduled history without
creating target resources or changing source bytes. The zero-live CLI restore also
remains refused. Its positive lifecycle case uses guarded restore followed by stock
controller startup. The receipt does not qualify ordinary CLI restore for that case.
Ownership negatives preserve a preexisting container and sentinel data, then refuse
the volume-only collision. A deliberate post-create digest corruption exercises
shared validation cleanup and retains all seven target volumes; it reuses the
preauthorized first retirement generation in its separate target storage.

## Accept the result

Require terminal driver exit zero and its final sealed receipt after cleanup.
Check source fingerprints against the executed revision, both added image layers,
exact immutable programs and independently verified signed proofs. Re-hash retained
artifacts and inspect controller histories, exact runner files, recovery holds,
source preservation, service exits and runtime logs. No owned installation may
remain running or retain a network. The accepted stop profile permits workerd exit
0 or 1; other services must exit 0 without OOM, runtime fencing or storage exhaustion.

The receipt qualifies only its recorded same-version, two-fleet Docker layout.
General lifecycle fencing, arbitrary in-flight callback drain, external effects
exactly once, expansion, unsupported recovery topologies, remote operation and
hosted Cloudflare execution remain outside its scope. Runtime selection, external
admin/TLS operation and ordinary cron admission retain separate
[M11c acceptance gates](m11c.md).
