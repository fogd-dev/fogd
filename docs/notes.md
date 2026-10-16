# Implementation notes

These notes preserve experiment results and failed approaches. Reproduction steps
for the current implementation live in the README.

This log records experiments, source revisions, verification, and unresolved gaps.

## Initial environment

The starting repository contains the published `@fogd/cli` stub and a clean main
branch with an existing unpushed repository-URL commit. Docker Desktop provides
Linux arm64 containers. Dependencies and upstream checkouts stay inside this repo.
No Cloudflare credentials, Cloudflare API calls, global installs, or npm publishing
are part of this work.

## Milestone order

1. Inspect pinned upstream source, write compatibility and architecture, peer review.
2. Generate and serve a Void starter with D1.
3. Exercise R2, Durable Objects, migrations, and node/runtime recovery.
4. Package local startup and deployment in the CLI.
5. Compare platform options and peer review the choice.
6. Implement and verify two apps through admin approval; write the final report.

## Repository creation

The initial push and `gh repo view fogd-dev/fogd` returned repository not found.
The user confirmed the organization was new and suggested creating the repo.
Created the public `fogd-dev/fogd` repository and pushed the preserved main history.

## Runtime artifacts

Audited upstream revisions are recorded in compat.md. The published celld 0.6.2
multi-architecture image pulled successfully on Docker arm64. The architecture
proposal keeps the full app in celld to avoid inventing binding protocols.

## Milestone 2 verification

- `npx --no-install void init`: D1 demo, deployment setup skipped, SQL generated.
- Local Vite build succeeded; initial multi-module output failed in celld because
  its no-bundle path collects only the entry JavaScript. ADR 004 records the fix.
- MinIO source Docker build succeeded. celld diagnose passed conditional create,
  reject-create, update, reject-stale, and signed probes of both live peers.
- Both replicas reported adoption of version `188014d5c6cdbcaf` through `/reload`.
- `celld d1 migrations apply hello-db /artifact` applied the generated SQL.
- `GET /api/posts` through workerd with the hello hostname returned `[]` (HTTP 200).
- The slim Node runtime needed system CA certificates for workerd startup. They
  are copied from celld's Debian image, without modifying the host.
- Deployment now waits for bucket initialization; the first direct deploy raced
  bucket creation and received NoSuchBucket before that dependency was added.

## Milestone 3 recovery investigation

The notebook uses a Drizzle D1 table, two SQL migrations, R2 object bodies, and a
SQLite Durable Object ledger whose unique operation IDs make repeated PUTs
idempotent. The writes across the three bindings are not one transaction.

The first recovery run exposed an upstream identity boundary: after A restarted
with a random ID, killing B blocked B's log recovery on the old A witness. The
saved log is not evidence of successful failover. Restoring both original IDs
against their original volumes recovered the existing entries without deleting
bucket data. ADR 005 records the supported configuration used for the repeat test.

Node's fetch ignored the Host override in the first test harness, so virtual-host
checks now use node:http. The runtime was responding correctly to curl; that
particular timeout was a harness bug, separate from the log-witness problem.

The repeated recovery run with retained replica identities passed both forced
container stops, both rejoins, and a workerd restart. It also rejected the public
Void migration route with HTTP 404. The acknowledged notebook state included the
R2 body and a Durable Object count of 3; a duplicate PUT did not increment it.

## Milestone 4 verification

`pnpm exec fogd deploy` ran successfully from both `examples/notebook` and
`examples/hello`. The CLI built and staged each app, published through celld,
verified both replica versions, and skipped already-applied SQL. The hello
version was `188014d5c6cdbcaf`; notebook was `1c2f1729170db2fa`. Both sample apps'
builds and the artifact validation tests pass. The direct mode is deliberately
single-app; milestone 6 replaces the public default with the approval API.

## Platform implementation and live acceptance

Claude and Gemini completed platform design reviews using valid CLI commands with
15-minute limits and streaming logs. Both chose the custom approval gate. Their
high-priority ownership, canonicalization, migration-reconciliation, and exact-digest
findings were incorporated; the proposal and response remain in `docs/reviews/`.

The platform smoke test passed against real Docker services: two CLI-built Void
artifacts, no route before approval, rejection, wrong-digest rejection, forbidden
submitter approval, malformed artifact rejection, both app hosts, D1/R2/DO writes,
intentional SQL syntax failure, corrected submission, and controller/workerd restart.
The invalid SQL was never recorded as applied; resubmitting the original artifact
restored the notebook without changing the checked-in sample migration history.

Eleven unit tests passed, including partial migration failure and restart/ownership
failure injection. Both sample production builds passed. No Cloudflare APIs, npm
publication, host-global installation, or Docker socket mounts were used.

## Fresh-checkout verification

Commit `3b00571` was checked out into a separate detached worktree with no build
outputs, `.env`, node_modules, or deployment state. `pnpm install --frozen-lockfile`
and `fogd up` succeeded with Compose project `fogd-clean`, fresh bucket/controller/
replica volumes, and alternate ports 8877/8878. Docker reused downloaded/base build
layers, but no prior deployment state. `scripts/platform-smoke.mjs` passed in full,
including both CLI builds and approvals, deliberately failed SQL, recovery, and
controller/workerd restart. Runtime versions matched the original checkout:
hello `188014d5c6cdbcaf`, notebook `1c2f1729170db2fa`.

The original platform fleet also passed `scripts/recovery.mjs`: both replicas were
force-stopped in turn, the survivor served acknowledged D1/R2/DO data, a new write
was made after the first rejoin, both replicas rejoined, and workerd restarted.
No missing-witness recovery errors appeared. The script defaults now target
notebook's second platform slot and allow replica-service overrides.

## Final verification after implementation review

The clean-checkout recovery test also passed with both replica failures, a write
between failures, and workerd restart. After Claude's implementation review, commit
`cd55741` passed the full approval smoke again with another fresh set of Docker
volumes (`fogd-final`, ports 8977/8978). Seventeen unit tests and both production
builds passed. The added regressions cover shrinking migration ledgers, duplicate
bucket ownership markers, concurrent/stale approvals, stored-artifact tampering,
encoded internal paths, and avoiding replay of ambiguous writes.

Both temporary acceptance stacks were stopped after verification; their volumes
were preserved. The primary `fogd` stack retains both approved sample applications.
The feature overview requested during implementation is in `docs/features.md`, with
runtime/API evidence separated from the capabilities fogd actually exposes.

## M7a local qualification, 2026-10-16

The native React guestbook uses the pinned Void starter generator, D1 schema and
Drizzle migration metadata. Its first build exposed inherited client inputs in the
worker environment; selecting Void's virtual worker entry fixed the single-module
build. The first activation exposed celld's rejection of `.assetsignore`; staging
with Void-style exclusion semantics fixed publication. Neither required an upstream
source patch. ADR 007 records the adapter boundary.

The browser smoke then exposed test-harness assumptions: React inserts comments
between text nodes in SSR HTML, hydration can finish after the form becomes visible,
and Playwright's browser path must be configured before importing its registry.
The assertions now check the route heading and API data, establish client readiness
with a read-only action, and initialize Playwright in one helper. The full smoke
passed from fresh Docker volumes through two releases and a controller/gateway
restart. The same browser helper passed against normal Void development with a
separate local database. The generated second release remains an ignored temporary
copy; the checked-in example always starts at release one.

The original example stack was stopped with its volumes retained. The disposable
`fogd-m7` project used the normal local ports and fresh test volumes; preserving two
running copies is not a requirement. Recreate examples from source when needed.

The verification image excludes host-generated Void/Wrangler state. With dependencies
already installed, a `--network none` run passed guestbook type-checking, ordinary
Vite build, and fogd build. No hosted deployment was attempted. These are agent-run
reproductions, not evidence that a second developer completed onboarding unaided.

M7a review fixes restrict uploaded worker files to the runtime entry and Wasm;
source maps and preview secret files are excluded. Asset secret exclusions cannot
be negated. The offline comparison observed 14 server JavaScript files in ordinary
Void output and one in fogd output; both retained `nodejs_als`, D1 `DB`, and the
same client asset configuration. These counts describe this fixture and pinned
build, not a size or determinism guarantee. The verifier now also stages the fogd
artifact while offline. Full findings and responses are in `reviews/m7-response.md`.

## M7b qualification, 2026-10-16

The first live growth run retained the guestbook's messages and passed attachment
upload/download, then failed with 404 at the private export endpoint. Gemini's
source review identified Void's exclusion of underscore-prefixed route directories.
Moving the endpoints into native middleware resolved it. Middleware returns HTTP
responses explicitly; plain objects are only converted by `defineHandler`.

The next run passed the logical roundtrip, invalid-checksum rejection, injected SQL
failure after R2 writes, identical retry, and post-restore writes. The original
platform smoke also passed after resource validation changed. The transfer command
was exercised twice with the same snapshot file. Final qualification includes a
101-row export refusal with a bounded-profile error and byte-for-byte attachment
reads after restart. Tests used disposable `fogd-m7b` volumes; prior installations
were stopped. No other Docker project's state was changed.

Gemini's specification review returned findings but reported an interrupted stream.
Its later implementation review completed successfully, as did both Claude reviews.
Original review outputs and accepted/deferred findings are under `docs/reviews/`.
Offline verification covers both base and grown apps: type-check, normal Void build,
fogd build, and staging with `--network none`. Hosted execution remains untested.
