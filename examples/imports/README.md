# Retained-input imports

A native Void app accepts up to 20 labels, retains their input in R2, queues work,
and records uppercase results in D1. The job URL lets a user return later. Explicit
retry replays retained input after delivery loss; completed imports are a no-op.

This is an M11a qualification app. Docker operators can enable the bounded queue
profile with `FOGD_QUEUE_APPS=1`, then submit this app with `fogd deploy` and approve
the exact artifact. See the [queue admission guide](../../docs/queue-admission.md)
for requirements and qualification steps. Ordinary CLI deployment, workerd routing,
browser reload/retry, pending-work recovery, and additive updates have passing
local evidence. Admission remains off by default; Kubernetes queues are unsupported.
The [direct-runtime guide](../../docs/queue-qualification.md#native-void-imports)
records the earlier lower-level probes separately.

```sh
pnpm --filter @fogd/example-imports typecheck
pnpm --filter @fogd/example-imports build
node --test examples/imports/test/*.test.mjs
```

`POST /api/imports` takes `{ "id": "demo", "text": "apple\npear" }`.
`GET /api/imports?id=demo` returns the durable job and ordered results.
`POST /api/imports` with `{ "id": "demo", "retry": true }` retries unfinished work.
An existing ID with different input returns 409. The qualification-only `mode`
(`retry-once` or `fail`) and `delayMs` fields inject failures and delay processing.
The app has no authentication and is not intended for an exposed production site.

Input storage, job creation, and queue submission are separate operations. A send
failure can leave a retained job without delivery; users can explicitly retry.
Conflicting submissions may leave unreferenced content-addressed input. No cleanup
policy is implemented. D1 batches commit results and completion atomically; a
per-job/position key makes repeated processing idempotent for these database rows.
This does not prove external effects happen exactly once. A killed consumer cannot
reliably write a failure row, so an empty queue never establishes job completion.

The `updates/v2` overlay adds a `processor` column with default `v1` and changes new
handlers to write `v2`. The update probe copies it into a private source checkout,
then verifies that an old handler can finish against the additive schema while a
new handler processes another job. It does not modify the base example.
