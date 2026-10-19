# Control queue delivery

Administrators can inspect recorded delivery state, refresh an observation, pause,
and resume through the CLI or approval page. The [bounded Docker queue profile](queue-admission.md)
requires explicit opt-in for new uploads and approvals. These controls also apply
to already approved queue apps when new admission is turned off.

Use the installation's admin credentials. Deploy credentials cannot operate queues.

```sh
fogd admin delivery imports status
fogd admin delivery imports observe
fogd admin delivery imports pause
fogd admin delivery imports resume DEPLOYMENT_ID ARTIFACT_SHA256
```

Copy both resume identifiers from the `active` object returned by `status`. The
controller refuses a different active deployment even if it has the same artifact
digest, because a new approval can select different secrets. The browser's resume
button carries the identifiers from the rendered page and displays both for review.

## Interpret the result

`desired` is the operator's intent. `effective` includes any activation hold, which
requires pause. `observed` and `observedAt` record the most recent confirmed
observation. They do not prove the queue's current state. `operation` records an
unconfirmed command; `hold` identifies the activation that must finish before resume.

`status` only reads controller state. `observe` contacts celld and can instantiate a
queue cell. It is therefore an explicit authenticated mutation with CSRF protection,
even though it does not change delivery intent. Observe never releases an activation
hold or clears a pending command. Use `pause` to reconcile pause intent.

Pause does not drain running handlers. It changes the durable operator preference,
which remains paused through later successful approvals. HTTP routing and queue
delivery are separate: an app can serve HTTP while its queue is paused.

Resume requires a completed active deployment, reconciled migrations, no hold, and
matching approval identifiers. The runtime gate then verifies both replica versions
and the selected queue cell's generation. An unavailable or mismatched runtime
cannot be resumed through this interface.

If a command cannot be confirmed, the API returns 502 with bounded diagnostics.
The journal retains unknown state and the pending operation. An attempted resume
records running intent even when its generation check subsequently refuses; it does
not prove a resume occurred. Refresh to inspect the runtime, or pause to withdraw
that intent. Metadata write failure returns 503 and requires controller restart to
reload durable state before further operations. See [recovery](recovery.md).

Retired, quarantined, and not-yet-bootstrapped fleets have no active controls. Their
recorded state remains readable. Runtime version hashes stay in controller storage
and are omitted from API/page/CLI views because they can incorporate secret values.

## API reference

All delivery endpoints require admin Basic authentication. POST requests additionally
require the current `X-Fogd-CSRF` token from `/v1/admin`, a permitted Origin when
present, and a JSON object body of at most 4096 bytes. The internal routing listener
never exposes these endpoints.

| Method and path | Body | Effect |
| --- | --- | --- |
| `GET /v1/apps/APP/delivery` | None | Read recorded state |
| `POST /v1/apps/APP/delivery/observe` | `{}` | Refresh the observation |
| `POST /v1/apps/APP/delivery/pause` | `{}` | Persist pause intent and confirm pause |
| `POST /v1/apps/APP/delivery/resume` | `{"deployment":"ID","digest":"SHA256"}` | Gate and request resume of that active approval |

Commands serialize with activation and publication. Values checked when an HTTP
request arrives can become stale while it waits, so validation happens inside the
controller lock. Purge, payload inspection, and arbitrary queue selection are absent.
Each app operates only its declared queue in its assigned fleet.

## Qualification

`packages/platform/test/admin-delivery.test.mjs` exercises the HTTP server, CLI,
delivery journal, and runtime generation gate. It checks authorization, CSRF, exact
approval identity, hash redaction, no-effect GET reads, unknown outcomes, metadata
failure, and validation after a request has entered the serialization queue.

`scripts/queue-admin.mjs SLOT EVIDENCE_DIRECTORY` drives the public admin endpoint
against a qualified disposable installation. `scripts/queue-admin-browser.mjs` clicks
the corresponding browser controls. Both expect the installation to serve controller
state for a privately staged imports app with delivery paused, and leave it paused.
They use `FOGD_ENV_FILE` like the other [queue probes](queue-qualification.md).
They do not provision an app or bypass public upload admission on the reader's behalf.
The [selected evidence](evidence/m11a-admin-delivery.json) records the qualified image,
observations, browser actions, and source hashes.
