# Native Void guestbook

Run this fixture to exercise Void React pages, server-rendered data, form actions,
the typed client, and D1 through fogd. Use disposable data; there is no app login.
Start in the repository root with dependencies installed.

## Local development

```sh
VOID_REMOTE=0 pnpm --filter @fogd/example-guestbook exec void db migrate
pnpm --filter @fogd/example-guestbook typecheck
VOID_REMOTE=0 WRANGLER_SEND_METRICS=false pnpm --filter @fogd/example-guestbook dev
```

Open the URL Vite prints, add a message, reload, and select **Check saved messages**.
Void's local database lives under the example's `.wrangler` directory. fogd uses
celld and the configured bucket instead; the two development databases are separate.
The [type contract checks](type-tests/client.ts) deliberately contain incompatible
uses marked with `@ts-expect-error`. Type-checking fails if those mistakes stop
producing errors.

## Deploy through approval

On a stack with an unused app slot:

```sh
pnpm exec fogd up
cd examples/guestbook
pnpm exec fogd deploy
pnpm exec fogd status <deployment-id>
```

Approve the printed digest at the local admin page, then visit
http://guestbook.localhost:8787. The app uses the same source as local development.
Use the configured base domain and HTTP port if you changed the defaults. The
shared deploy token permits team status reads; it cannot approve or inspect full
artifacts. Administrators retain detailed failure diagnostics.

For a schema change, edit `db/schema.ts`, run `pnpm exec void db generate`, and
submit again. Keep applied SQL unchanged. Use backward-compatible changes; approval
pauses new HTTP traffic but does not drain requests already running.

## Repeat the two-release qualification

From the repository root, install the browser inside this checkout:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.fogd/browsers" pnpm exec playwright install chromium
node scripts/fullstack-smoke.mjs
```

This script needs a running stack with an unused slot and no app named `guestbook`.
It rejects a release, approves the first release, exercises the browser, generates
an additive migration and history page in an ignored temporary copy, approves that
second release, checks old and new data, and restarts the controller and workerd.
It leaves the second release running. It does not delete existing apps or volumes.
Use an unused `FOGD_APP_NAME` to rerun if a slot remains. Otherwise recreate only a
disposable test stack. Set `COMPOSE_PROJECT_NAME` consistently if using a named stack.
The current prototype has two slots and no app retirement operation.

The same browser check can target a running local development server:

```sh
node --input-type=module -e 'import { verifyBrowser } from "./scripts/guestbook-browser.mjs"; await verifyBrowser("http://127.0.0.1:5173", "Local development check");'
```

To qualify both build targets without network access during compilation:

```sh
docker build -f docker/verify.Dockerfile -t fogd-verify:local .
docker run --rm --network none fogd-verify:local
```

Dependency installation during image construction needs network access. The run
performs type-checking, normal Void/Vite build, fogd's build, and artifact staging
for both the base guestbook and its attachment update.
It retains both build outputs inside the container, prints their differences, and
refuses to run when a non-loopback network interface is present. No deployment to
Cloudflare is performed. See [artifact mapping](../../docs/build-output.md).

For R2 additions and bounded logical data transfer, follow [TRANSFER.md](TRANSFER.md).
