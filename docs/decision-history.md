# Inspect administrator decision history

The source controller records authenticated approval and rejection decisions and
provides a read-only history page at `/admin/decisions`. Administrator Basic
authentication is required. This implementation is part of
[issue 7](https://github.com/fogd-dev/fogd/issues/7); the frozen v5 runtime and
prepared `0.1.0` artifact do not contain it. A new runtime build and qualification
are required before it becomes a qualified release capability.

## Read the records

Follow **Decision history** from the source controller's approval page. Each row
identifies the authenticated administrator credential, app, submission ID,
artifact digest, action, requested secret revision and recorded outcome. Basic
credential names are stored as they were configured at the time of the decision.
Credential names must be nonempty, at most 256 characters and free of control
characters. Shared credentials identify one credential, not distinct people. Browser-supplied
actor labels cannot replace that authenticated identity.

| Outcome | Meaning |
| --- | --- |
| `started` | Decision intent was recorded; no final outcome is available yet |
| `succeeded` | The controller durably recorded completion of approval or rejection |
| `activation-failed` | Approval ran and the controller recorded a failed activation |
| `refused` | The decision was refused before its activation/rejection effect boundary |
| `unconfirmed` | The controller cannot establish the decision's completed outcome |

The application-status column is the status at the last durable decision
checkpoint, not a live health check. After an interrupted final write, a decision
can remain unconfirmed even when the deployment record is active. Inspect the
current application and its original operation before deciding what to do next.
History never retries a decision automatically. Successful approval is not proof
of the application's business outcomes or current health.

The controller records intent before effects and persists the outcome separately.
A metadata write failure uses the existing storage fence; it cannot be bypassed
by another approval request. On restart, unfinished intents become unconfirmed.
Decision metadata carries a required platform capability so older readers refuse
it instead of silently discarding history. History remains in controller metadata
when artifact bytes are pruned; it has no automatic truncation policy.

The current operator CLI validates history before backup and restore, preserves
the saved rows and requires a runtime that understands their capability. Missing,
malformed or mismatched history refuses recovery; installation transformations
cannot discard it. Owner diagnostics validate private history or the authenticated
count summary without treating a withheld app as ready.

The [native recovery receipt](evidence/operator-decision-history-recovery-v6.json)
records a fresh-volume restore, retained failed-approval hold, explicit corrected
approval and retry, preserved app data, and a stopped cron/queue snapshot. It does
not qualify background restore or ordinary admission of the candidate family.
Separate [background restore evidence](evidence/operator-native-background-recovery-v6.json)
now covers a paused v6 cron/queue snapshot on fresh volumes, retained decision
history, explicit recovery acknowledgment and separate live resumes. This bounded
same-family check does not open v7 admission.

## Query the authenticated feed

The same administrator credential can read JSON:

```http
GET /v1/admin/decisions
GET /v1/admin/decisions?app=my-app
GET /v1/admin/decisions?app=my-app&before=DECISION_ID
```

Responses contain at most 100 entries, newest first, and an optional `next` cursor
for older records. Keep the same app filter while paging. The cursor is exclusive. History reads can wait for an ongoing activation.
The ordinary admin-state response includes counts instead of the full history.

Records omit secret values and raw runtime diagnostics. The page escapes stored
labels and keeps the existing authentication, no-store headers and content
security policy. Mutation requests still require the existing CSRF/origin checks.
Direct trusted in-process controller calls without HTTP authentication do not
invent an authenticated principal; the HTTP interface supplies the recorded
credential identity.

[Source integration evidence](evidence/operator-decision-history-source.json)
covers durable intent, attributed outcomes, interrupted final persistence,
restart without replay and a headless browser. It uses a controlled in-process
backend and does not qualify native runtime behavior. The [verified browser comparison](browser-release-review.md) and contextual
decision controls are implemented in source; new runtime qualification remains
open under issue 7.
