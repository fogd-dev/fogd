# Selected-runtime pause with an unreachable member

This is a historical qualification profile. For current admission and scope, see
the [M11c acceptance audit](m11c-acceptance.md). Reproduce it with the source
revision identified below.

The [selected pause receipt](evidence/m11c-selected-runtime-pause-unreachable.json)
qualifies the unreachable-member part of M11c gate 3 on the frozen local Linux
arm64 Docker candidate. A failed pause preserves unconfirmed intent while native
work continues. Controller restart preserves that state; explicit retry after
member rejoin confirms pause. Full M11c acceptance and public catalog admission
remain open. Ordinary cron admission stays closed.

This profile uses two application fleets, two native replicas per fleet, the
installed controller's HTTPS admin API, scoped CLI upload and exact artifact/secret
approval. The runtime catalog pins the same product, storage and native programs
used by the other selected profiles. Dependencies and images must already be cached.
The run installs nothing and builds no image or native program.

## Unconfirmed pause

The source completes autonomous healthy work before the cut. The fixture stops the
non-owner member through Docker's graceful stop API and confirms exit zero, no
OOM and no automatic restart. Signed process keys, live leases and owner epoch
identify the selected survivor. An absent identity endpoint is checked separately.

Ordinary `admin dispatch refresh pause` refuses while the member is unavailable.
The saved journal records `desired: paused`, `operation: pause`, `observed: unknown`
and no observation timestamp. There is no activation hold or migration uncertainty.
The native control revision remains unchanged and native dispatch remains running.
This is persisted intent, not a confirmed pause.

The controller receives SIGKILL and restarts in the same container while the member
stays stopped. The journal remains unchanged and unconfirmed. Both jobs then
complete a future scheduled occurrence after controller restart, before the member
returns. The fixed read-only diagnostic joins successful attempts to complete
occurrences and saved results; it never issues pause, resume or manual job triggers.

The recorded controller route lookup remains active throughout these checkpoints.
This profile does not exercise gateway HTTP availability during the outage.

Cron ownership and the advisory waker role need not belong to the same node.
Selection records both roles and fixes a continuation deadline with a 180-second
floor. If the stopped member holds the waker role, the checked native waker/lease
defaults can extend that deadline. The fixture makes one member cut and bounds its
wait for future work. In the accepted run, the stopped member holds neither role.
This case does not measure takeover of a stopped waker.

## Explicit retry and held work

The same member container returns with a fresh native process and signing key.
The survivor's and control fleet's native processes and signing keys remain
unchanged. The journal is still unconfirmed at rejoin, and native dispatch is still
running. An explicit operator pause then confirms, clears the unfinished operation
and advances the native control revision.

The held observation lasts at least 62 seconds and extends through the next minute,
the native 15-second operation deadline and a two-second margin. The profile's
healthy callbacks have already completed; this margin does not qualify termination
of arbitrary callbacks. All recorded attempt, occurrence, result, fixture-control
and settings rows remain unchanged. Native pause, control revision and null next
alarm remain confirmed. HTTP route state is separate from this dispatch control.

## Independent evidence

The native run takes 256.232 seconds. Independent acceptance verifies 632 recorded
source files, 121 static local imports, the five-program mounted observer inventory,
15 signed challenges and 15 altered-signature refusals. It checks both retained
controller artifacts, the independent policy and all 65 image program/binary hashes.
All eight volumes remain, with no owned containers or networks.

Static import analysis starts at the driver and CLI. The mounted observer programs
have an additional exact source-list/hash check; their image imports are bound by
the separate image inventory. Dynamic imports, `require()`, generated subprocess
code and installed dependency contents remain outside the static import walk.
Source and lockfile fingerprints are retained with the private evidence.

The auditor checks native and controller process identities, chronological cuts,
recorded route lookups, the unconfirmed journal at rejoin, actual future work and
the final held sample's own VM timestamps. Python optimized execution is refused;
a completed audit cannot be overwritten by a later run. Public summaries identify
their retained writer and scanner by hash. A printed pass alone is insufficient.

All 987 tests, syntax checks and the quality gate pass. Twelve weakened journal
validators and six weakened continued-work oracles are rejected. The final raw
receipt is scanned for seven credential and application-secret values. Published
records omit scoped credentials, secret values and private native versions.

## Reproduce and retain

Use the commit introducing the receipt, with the catalog's pinned images, cached
app dependencies and checked native source tree already available. Preserve
unrelated installations. The output directory must be new and private:

```sh
node scripts/cron-probe/selected/pause-unreachable.mjs .fogd/selected-pause-unreachable
```

Retain the actual terminal exit, logs, source archive, raw observations, independent
auditor and receipt hashes. Failed and interrupted runs retain their own volumes
and evidence and do not count toward acceptance. Temporary reviews and handoff
files stay outside the repository.

This profile does not qualify general drain, lifecycle/rebalance fencing, per-worker
CPU quotas, CPU exhaustion, remote or three-fleet scheduled recovery, Workflows,
arbitrary Durable Object alarms, external effects exactly once, or hosted
Cloudflare execution.
