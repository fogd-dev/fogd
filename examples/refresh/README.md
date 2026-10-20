# Scheduled refreshes

This Void example refreshes saved inventory and advisory information without an
open browser. It is an experimental M11c fixture: ordinary fogd cron admission
remains closed. The native qualification path uses private controller staging and
the pinned runtime controls described in the [activation guide](../../docs/cron-activation.md).

Both files in `crons/` export the same minute expression. Void invokes both jobs
for that expression and reports failure if either fails. The inventory job keeps
working while the deterministic local advisory source simulates trouble. The page
shows each job's last successful value, its latest outcome and recent attempts.
Source changes do not trigger jobs. This demo has no sign-in; anyone with access
can change its simulated source.

## Build and test

Use this checkout's installed workspace dependencies:

```sh
pnpm --filter @fogd/example-refresh typecheck
VOID_REMOTE=0 WRANGLER_SEND_METRICS=false pnpm --filter @fogd/example-refresh build
node packages/cli/src/build.mjs examples/refresh
node --test examples/refresh/test/*.test.mjs
```

The first build uses ordinary Void's target; the second uses fogd's single-worker
build. Both declare one cron expression and the required `REFRESH_TOKEN` server
value. The value is injected by the qualification controller after artifact review;
it is never a source-code default or a browser value. Missing-value build warnings
do not authorize execution without it. Neither build contacts a Cloudflare account.
The [offline verifier](../../scripts/verify-builds.mjs) repeats both builds in a
container with networking disabled and asserts that normal fogd staging rejects
the cron declaration.

## Retry behavior

The [job implementation](lib/refresh.mjs) keys its occurrence ledger by job,
expression and original scheduled time. Each invocation records its attempt before
doing work. A D1 batch commits the result and completion record together. Retries
of completed work skip its business writes; a later failure cannot demote a
completed occurrence. Concurrent writes also share the result table's unique key.

The advisory source supports four demo modes: healthy, one failure per occurrence,
unavailable, and a reply lost after save. A lost reply throws after the batch has
committed. Void retries the expression, including the successful inventory sibling.
Each job's ledger prevents another result row for that occurrence. The latest
success is queried independently for each job, so a long advisory outage cannot
hide its saved value behind newer inventory results. Success timestamps record
completion rather than the beginning of an attempt.

The unfinished-work section separately queries pending occurrences with no
completion for a minute, or with a later successful refresh for the same job. It
shows the oldest twenty matching records and counts the rest. Later success does
not erase an earlier unfinished occurrence. These records report missing completion,
not proof that no external effect happened. Failed rows remain failures. The
example retains this history and gets fresh data on future ticks; it has no general
replay or acknowledgment action.

This protects the example's D1 writes. It provides no exactly once guarantee for
external effects. A failed row records an observed failure; it does not establish
that the runtime will retain every retry or missed minute. A source mode change can
affect a later retry as well as a future scheduled occurrence.

## Native qualification

Use a fresh disposable two-node fleet with the qualified cron runtime. The private
fixture's workerd service points `FOGD_CONTROLLER` at `controller:8084`, where the
probe serves normal authenticated route lookups from its isolated controller.
The main controller retains its ordinary closed-admission configuration.

```sh
FOGD_ENV_FILE="$PWD/.fogd/void-refresh-fixture/probe.env" \
  node scripts/cron-void.mjs slot-1 .fogd/void-refresh-evidence
```

The [probe](../../scripts/cron-void.mjs) observes a minute before approval, activates
the built app with schema and private configuration, and waits for real native
callbacks through workerd. It checks sibling retries with the browser closed,
retained success during a source failure, the rendered failure state, and a lost
reply after a committed result. It reads saved rows through both replicas and the
native D1 CLI. Workerd blocks `/__void/*`; an artifact-embedded manual trigger key
is not the public security boundary.

Inspect its private evidence, require a successful runner exit and cleanup, then
stop the disposable installation while preserving its volumes. The probe leaves
dispatch paused. It does not qualify normal scoped cron upload admission, runtime
owner loss for this app, release replacement, full stopped recovery or retirement.
Those first two have separate [failure](../../docs/cron-failures.md) and
[replacement](../../docs/cron-replacement.md) profiles; recovery and retirement
remain open.
