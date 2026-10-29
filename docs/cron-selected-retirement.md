# Selected-runtime sequential retirement

This is a historical qualification profile. For current admission and scope, see
the [M11c acceptance audit](m11c-acceptance.md). Reproduce it with the source
revision identified below.

The [selected sequential retirement
receipt](evidence/m11c-selected-runtime-retirement-chain.json) qualifies this
bounded profile on the frozen local Linux arm64 Docker candidate. The complete run
and independent audit both exit zero. The complete M11c acceptance audit remains
open. Public candidate enrollment and ordinary cron admission stay closed.

No retirement in this chain runs beside another live cron. The separate
[selected dual-cron profile](cron-selected-retirement-dual.md) covers that case.

This profile exercises successive retirements on the frozen local Linux arm64
candidate through ordinary scoped HTTPS deployment and approval. Each retirement
creates a separate stopped installation. Earlier installations remain stopped,
and all volumes are retained.

## Runtime and build boundary

Use the commit that introduces this receipt. Its recorded base commit alone omits
the new qualifier; the receipt identifies every executed source file.

The candidate is `celld-cron-v2-linux-arm64`, with product image
`sha256:b2e9e39d3f7fb00be9e5716160775d0a624b521aa6f0d40a69ddbad3b8c0a1a9`.
The runtime catalog pins its native binary, supervisor, storage image and shipped
program inventory. The run verifies cached images and the actual native timing
environment. It does not build images or native code.

Application fixtures use the ordinary Void/fogd build and scoped upload path with
cached dependencies. The private refresh copy adds fault controls and diagnostic
SQL. Native cron executes the jobs; an HTTP request does not trigger them. This
profile does not repeat the separate offline-build qualification.

The native defaults remain a 300-second handler budget, 15-second operation
deadline, 30-second generation reap, 60-second waker interval, 180-second role TTL
and 10-second node TTL. These are timing and lifecycle controls. Per-worker CPU
quotas and CPU-exhaustion behavior remain unqualified.

## Retirement chain

The source has a healthy minute cron and a paused imports queue containing real,
unattempted input. A stopped backup holds the selected cron before its armed
deadline. Retirement preserves the cron's policy, ledger, secret revision and
controller artifacts while moving only the retired queue fleet to fresh node IDs
and a fresh namespace.

The restored native processes start before the controller and ingress. The live
cron stays held across a cold interval and another interval after explicit recovery
acknowledgment. Both last at least 62 seconds. Separate resume produces future
jobs without changing old occurrence, attempt or result rows.

An ordinary queued replacement uses the freed capacity. Its tables and backlog
start empty. It processes fresh input; the old credential cannot upload to it, and
the retired name cannot receive a new token, upload or approval. Retired namespace
bytes and private controller files remain intact.

The replacement queue is then paused with new pending input. The original cron
runs a terminal-failure fixture. Selection fixes the first minute after resume,
requires exactly three settled advisory failures and selects its persisted retry
using a fresh clock read. A missed minute, fourth failure or insufficient margin
refuses the run. Backup must confirm pause before that exact retry becomes due.

Retiring the cron preserves the queued survivor and its pending input. After held
recovery and acknowledgment, separate delivery resume completes that input. A
new cron takes the freed fleet with empty ledger tables, fresh seed rows and a
different required-secret value and revision. Missing or old secret revision,
retired credentials and retired-name mutations are refused.

The new cron uses `*/3 * * * *`; the retired cron used `* * * * *`. Its fresh paused
state has no wake or alarm. Every future and subsequently archived ledger row must
use the new expression and a three-minute boundary newer than resume. The next
armed alarm must agree. This cron is retired beside the queue, followed by
retirement of the final queue with retained input.

A final zero-live snapshot contains four tombstones and no live background
contracts. Ordinary stock controller startup and held recovery preserve this
history. Separate audit restores also check the original retry snapshot and the
original two-app snapshot, including their unchanged ledgers and queued input.

## Evidence checks

Before each backup, the tool reads the source controller's live approvals and
retirement history. The archive must retain that history exactly. Later backups
use the enrolled canonical Compose configuration, including changed namespace and
node bindings; the original template is not the recovered installation's config.

Each retired prefix is compared with the source archive for that restoration hop.
The checks compare complete entry names and GNU tar's file contents and metadata.
Logical object fingerprints remain equal across later operations and hops. No
claim is made that directories' timestamps are immutable.

The unused namespace must be empty before native startup. After held startup it
may contain only the selected fleet's own leases and bootstrap/capacity metadata.
Application data, deployment pointers, timer entries and foreign node leases are
refused. New generation IDs, prefixes and node IDs cannot reuse retained history.

Signed observations bind binary, node, namespace, storage origin/region and process
key to fresh challenges. The independent auditor rebuilds key maps from the raw
proofs and checks signatures with OpenSSL, including altered-signature refusal.
Source and restored process keys may differ. Cold and warm keys within one target
must match, and native process identities must remain stable.

The audit also reads retained controller and policy volumes independently, checks
approved artifact hashes and separate secret ownership, walks the complete shipped
program inventory, verifies snapshot hashes and compares every source-volume entry
with its archive. Final checks require stopped services, no owned containers or
networks and every retained volume still present. Public surfaces, decoded
artifacts, diagnostics and the actual receipt bytes are scanned for credentials
and app-secret values.

The recorded run takes 1,882.970 seconds. Independent acceptance verifies 485
recorded source files, 82 signatures and 82 altered-signature refusals, eight retained
controller volumes and 64 retained volumes in total. It compares 1,932 complete
source-volume entries and 15 restored retired-prefix subtrees with their archives.
All 959 tests, syntax checks and the quality gate pass. Five weakened oracle
variants fail their tests. Backup confirms pause 8.693 seconds before the selected retry is due. The raw receipt scans 24 credential and app-secret values before and after
writing its final bytes.

The historical source inventory omits the imported queue-prefix fingerprint
helper and shared browser helper. Its 485 archived file hashes and independent archive-to-volume comparisons
remain valid within that recorded scope. The [dual-cron profile](cron-selected-retirement-dual.md)
adds both helpers to its expanded inventory and checks the driver and CLI static
import graphs. The earlier inventory is not a complete executed-import archive.

## Run and retain

The historical receipts above identify their executed drivers and source inputs.
The current driver requires an explicit candidate family; the
[v5 check](evidence/operator-native-background-retirement-v5.json) records its
tested durable profile. Cache the selected product/storage images and app
dependencies. Preserve unrelated installations and choose a new private output:

```sh
node scripts/cron-probe/selected/retirement-chain.mjs \
  --runtime celld-durable-v5-linux-arm64 --candidate --retain-resources \
  /private/new-retirement-observation
```

`result.json` is written only after the source inventory and source state still
match the start of the run. Retain the actual terminal exit, logs, archived
executable sources, source fingerprints, snapshots and post-write receipt hash.
A printed pass alone is insufficient; the independent audit must also finish
successfully. Interrupted and failed runs retain their separate evidence and
volumes and do not count toward acceptance.

The independent auditor is a private operator acceptance artifact identified by
`independentAudit.verifierSha256` in the receipt. The tracked driver reproduces the
native checks; the retained reviewed auditor supplies the separate acceptance
checks. Keep it with the private run evidence. Handoff and temporary review
documents stay out of tracked files.

This profile does not qualify remote or three-fleet scheduled recovery, Workflows,
general Durable Object alarms, arbitrary untrusted tenants, external-effect
execution exactly once, general drain, lifecycle or rebalance fencing, or hosted
Cloudflare execution.
