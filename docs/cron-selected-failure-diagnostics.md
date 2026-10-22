# Selected runtime failure diagnostics

The selected owner-loss diagnostic checks a native retry after its owner exits
on the frozen `celld-cron-v2-linux-arm64` candidate. It uses normal scoped HTTPS
upload, exact artifact and secret approval, and the runtime's default timing.
The [receipt](evidence/m11c-selected-runtime-owner-diagnostic.json) records one
local Linux arm64 Docker run with two application fleets. Full
[M11c failure acceptance](m11c.md) and ordinary cron admission remain open.

## Reproduction

Use a separate checkout of the commit that introduces the receipt. Its host
source hashes identify the executed files; the recorded base commit alone does
not contain the qualifier's uncommitted work. The cached product and storage images must match
[runtime selection](runtime-selection.md). The fixture requires its cached SDK
dependencies already installed. Then run:

```sh
node scripts/cron-probe/selected/failure-owner-smoke.mjs .fogd/selected-owner-UNIQUE
```

The output directory must be new. It contains private operator credentials,
artifacts, logs and raw observations, outside version control. The qualifier
uses internal candidate enrollment; public selectors still refuse this family.
It builds the fixture with cached SDK dependencies and does not build images,
compile native code, install dependencies or call hosted services.

One missed or ineligible cut invalidates that scenario. There is no retry within
the scenario to obtain a preferred owner, waker or deadline. Failed runs retain
their named volumes; a subsequent run uses a fresh installation and directory.

## Paused preparation

The app starts through ordinary upload and approval and reaches confirmed pause.
The qualifier records signed membership, application rows and actual Docker
container, image, network and native process bindings. If the cron owner already
holds the advisory waker role, it records that state without restarting a peer.
Otherwise, it gracefully stops the other replica, checks its shutdown logs, and
waits for the owner to hold the role through native lease expiry and election.
It does not rewrite owner or waker records, disable rebalancing, or change native
timing settings.

The same peer container restarts. Complete membership verification must show a
new key only for that process, unchanged application rows and confirmed pause.
Runtime observations require the cron cell resident on the approved generation,
with no observed handoff, adoption or restoration activity on either replica.
Those samples are observations, not an atomic rebalance fence. The recorded run
includes this paused peer restart; the later survivor is therefore a restarted
process with its own native tick phase.

## Owner-loss observations

After explicit resume, the native minute occurrence must produce two completed
advisory failures and successful inventory attempts. The cut requires a persisted
future retry, the same owner and waker, the prepared ownership epoch, a resident
cron cell and quiescent replica counters in the pre-cut sample. The qualifier confirmed the
SIGKILL 7,609 ms before that retry deadline. Docker must confirm exit
137, no OOM, no automatic restart and the exact selected container.

Storage observations preserve the retry publication, node leases and waker role.
Fresh survivor proofs remain bound to the original process key. The full runtime
guard refuses before sending a cron command; ordinary operator observation stays
unconfirmed with recorded runtime state unknown. The probe retains unavailable
ledger reads rather than treating them as empty results.

The survivor acquires the role within the measured default election window and
completes the original scheduled occurrence. This run has three native attempts
per job: inventory succeeds three times; advisory throws twice and then succeeds.
Business results remain unique through application idempotency. These counts do
not establish a universal callback ceiling or exactly once external effects.

The killed owner restarts in the same container with a fresh process key. The
survivor and other fleet retain their processes; completed import rows stay
unchanged. Normal guarded observation works again, and a later healthy native
occurrence completes before final pause and shutdown.

## Evidence and remaining gates

The receipt records exit code 0 and a duration of 441.7 seconds. Independent checks verify 435
host source hashes, 207 signed proofs and 207 altered-signature refusals, original
retry identity, unique results, preserved control data, service exits and all
eight retained volumes. The recorded workerd exit code is 1, which this profile permits;
the other seven services exit with code 0. No service reports an OOM or automatic
restart. A separate image audit verifies the 63 shipped source
files, native binary and supervisor. Privacy checks include decoded artifacts,
scoped status, operator surfaces, ordinary errors, peer and runtime logs, and the
complete final receipt bytes. Read-only observer mounts do not make native SQL
or status requests physically read-only: they can materialize resource cells.

This diagnostic uses an online-built minute artifact. Selected `noRetry`, sparse
terminal failure, full-slot downtime, ordinary offline builds, and browser failed
work remain open. Compatible replacement, active-survivor and pending-retry
retirement, and the complete selected-runtime audit retain their M11c gates.
The evidence does not qualify CPU exhaustion, per-worker CPU quotas, remote
hosting, Kubernetes scheduled recovery, Workflows or arbitrary Durable Object
alarms.
