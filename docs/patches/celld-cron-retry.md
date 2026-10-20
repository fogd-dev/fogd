# celld cron retry identity candidate

The pinned celld runtime loses a retry's original occurrence identity when the cron
object is reconstructed. The [native owner-loss evidence](../evidence/m11c-cron-retry-negative.json)
shows the surviving node treating the retry deadline as `scheduledTime` and rerunning
an expression that already succeeded. The [patch](../../patches/celld-0.6.2-cron-retry.patch)
passed one built two-node owner-loss experiment. It remains an experimental patch;
cron admission in fogd remains closed pending native timeout tests and operator controls.

## Evidence and proposed behavior

The negative control observes two expression callbacks, their original scheduled
minute, a published retry wake entry and the owning node. It kills that owner
before the recorded retry deadline and keeps it down until after the survivor
records its outcome. The new owner has a higher ownership epoch and runs the same
release hash. Both expressions run at the fractional-minute retry deadline, including
the previously successful sibling. A wake entry alone is not a general SQLite
durability proof; the recovered callback results establish this particular outcome.

The candidate stores the retry count, original occurrence, expression identities
and alarm deadline in the cron object's SQLite KV storage. A synchronous storage transaction commits that record with the alarm change. Each
armed occurrence has a record before execution, and runtime-enforced backoff retains
its original time. Reconstructed objects load the record. Expression identity survives declaration reordering; removed expressions
are not redirected to another callback. The native next-occurrence and retry-limit
policy remains in place. This does not create a backlog of every missed tick.

An alarm written by an older runtime may have a non-minute deadline without a
retry record. The candidate skips that unidentified retry and schedules the next
future occurrence. It cannot reconstruct missing identity and must not invent a
new occurrence key. This is a compatibility limitation, not recovered work. An interrupted callback
group can repeat already-successful effects, so applications still need idempotency.
A hard interruption can also repeat a callback that called `noRetry()` earlier in
the same group. Native backoff can cross the next scheduled minute; later missed ticks are not
backfilled. The candidate caps a native alarm retry at six attempts, then advances to the next
scheduled occurrence. The bound applies per armed alarm because each application
retry resets celld’s counter. A callback that repeatedly times out can also prevent
its later siblings from running. The cap can skip work; it does not provide a dead
letter record or operator retry control. The number mirrors celld’s
`RETRY_CEILING` and must change with that upstream constant.

Stop every node before replacing the runtime, then start all nodes on the same
patched image. This causes full downtime because celld starts dispatch as soon as
any node starts. The candidate does not support rolling replacement, mixed versions
or rollback. An operator pause does not exist yet, so this cutover is manual. A stock
node can advance the alarm but leave the cron record stale, causing a later retry to
replay the wrong occurrence. A future rollback procedure must reconcile the alarm
and record while every node is stopped; do not delete live keys.

The arming guard reads native active-alarm state, which settlement clears even when
V8 termination skips JavaScript cleanup. The [Claude reviews](../reviews/m11c-cron-patch4-claude.md)
found no blocker for a disposable installation. Native CPU-timeout qualification remains
pending. The [review response](../reviews/m11c-cron-patch-response.md) records the failure
cases that motivated the revised candidate.

## Source regression

The [regression runner](../../scripts/celld-cron-regression.mjs) executes the actual
cron class with modeled storage, event and planning primitives. Its plan model
covers only the two every-minute expressions used by the native probe. It tests
reconstruction, cold arming, reordered/removed expressions, atomic rollback, generic
backoff across minutes, missing alarms, active-handler arming, legacy missing
identity and the next-occurrence policy. It does not replace a real runtime
owner-loss test, a native transaction fault test, CPU-timeout test or arbitrary cron grammar tests.

```sh
node scripts/celld-cron-regression.mjs \
  .fogd/celld-cron-source/crates/celld/js/harness.js
```

The unmodified pinned class fails the occurrence/sibling regression. The candidate
passes fifteen modeled cases. The runner does not prove celld’s native retry or
transaction lifecycle.

## Build an experimental candidate

Use a fresh source directory, the pinned commit, and the labelled patches. The
`lab` profile supports functional experiments; it is not a performance result.

```sh
git clone https://github.com/denoland/celld.git .fogd/celld-cron-source
git -C .fogd/celld-cron-source checkout 90b43017241f81189453d326d05948f388b34652
git -C .fogd/celld-cron-source apply "$PWD/patches/celld-0.6.2-cron-retry.patch"
git -C .fogd/celld-cron-source apply "$PWD/patches/celld-0.6.2-preaccept-attachment.patch"
docker build --target build --build-arg CELLD_PROFILE=lab \
  -t fogd-celld-cron-build4:local -f docker/celld-cron-build.Dockerfile \
  .fogd/celld-cron-source
docker build -f docker/celld-cron-patched.Dockerfile \
  --build-arg CELLD_TESTED_IMAGE=fogd-celld-cron-build4:local \
  -t fogd-celld:cron-retry .
docker build -f docker/runtime.Dockerfile \
  --build-arg CELLD_IMAGE=fogd-celld:cron-retry \
  -t fogd-runtime:cron-retry .
```

Build the package image from the lab build image with
`docker build -f docker/celld-cron-patched.Dockerfile --build-arg
CELLD_TESTED_IMAGE=fogd-celld-cron-build4:local -t fogd-celld:cron-retry .`. Keep it
separate from existing runtime tags and use a disposable installation. The completed qualification
must record image and binary digests, source patch hashes and native results before
any supported capability claim. Timer holds, operator controls, activation and
recovery remain separate [M11c obligations](../m11c.md).
