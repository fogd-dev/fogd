# Selected runtime stopped recovery

This is a historical qualification profile. For current admission and scope, see
the [M11c acceptance audit](m11c-acceptance.md). Reproduce it with the source
revision identified below.

This profile checks due timers, pending retries and an older snapshot on the
`celld-cron-v2-linux-arm64` candidate. It uses normal scoped HTTPS deployment,
exact approval, stopped CLI backup, independent restore selection and canonical
installed startup. The catalog candidate and ordinary cron admission remain closed.
The [M11c contract](m11c.md) retains its other acceptance gates.

The profile requires the cached Linux arm64 product and storage images pinned by
[runtime selection](runtime-selection.md). It does not build images, compile native
code, install dependencies or call hosted services. Its ordinary Void fixtures use
cached SDK dependencies. Four installations use separate named volumes and
nonoverlapping Docker networks. One private `FOGD_HOME` contains their source
relationships; every operation that resolves that home runs in a fresh process.

## Reproduction

Use a separate checkout of the commit that introduces the
[evidence receipt](evidence/m11c-selected-runtime-recovery-matrix.json). Its host
file hashes identify the executed source; the recorded base commit alone does not
include the qualifier files that were uncommitted during execution. Then run:

```sh
node scripts/cron-probe/selected/recovery.mjs .fogd/selected-recovery-UNIQUE
```

Use a fresh output directory. The qualifier creates private operator credentials,
artifacts, snapshots and raw evidence there. Those files contain recovery inputs;
they stay outside version control. It enrolls the candidate through an internal
qualification path. Public selectors must still refuse the candidate.

One failed snapshot preparation invalidates that selected alarm. The qualifier
makes one backup attempt and requires its pause receipt to identify the selected
alarm and complete before the alarm deadline. It records preparation latency.
A failed run retains named volumes and records its failing phase; a later run uses
a fresh installation and output directory.

## Recovery cases

| Case | Selected source state | Required destination behavior |
| --- | --- | --- |
| A | A future minute timer, with completed queued work | The old deadline passes with both dispatchers held; explicit resume produces future cron work |
| B | A persisted native retry after repeated advisory failures, plus one unattempted queued input | The same original broker message and accepted input remain held; delivery resume finishes it without producer resubmission; cron resume does not replay the old occurrence |
| Older A | The original A snapshot after later successful work on A and B | Later import and cron results are absent; each app receives a fresh recovery ID and requires acknowledgment and separate resume |

The queued-input check compares the original message ID, body and zero attempts
with the selected B snapshot and restored observations. It also checks the
application input hash, creation time, pending state and absence of prior results.
After delivery resume, saved native rows show durable business results and an empty
broker queue. Queue delivery remains at-least-once; unique business results do not
establish exactly one native consumer invocation.

## Held checkpoints

Restore creates all eight services without starting them. The qualifier checks
actual image IDs and network placement against the independent policy. Candidate,
missing-selector and wrong-source-identity refusals must leave no target state.
Before each restore and cold start, every known peer and its full volume set must
be stopped. The host's source records provide an additional related-project fence.

The cold phase starts only storage and the four native nodes. Controller and
gateway must remain never-started: one ordinary container each, zero restart count
and the initial Docker start timestamp. Independent readers use the pinned image,
read-only controller and policy mounts, and only the appropriate fleet network.
They read persisted wake records before cron status. Application tables, migration
ledgers and queued messages must match the snapshot for at least 62 VM seconds
and through the selected old deadline. Cron has no persisted wake or next alarm.

Normal `up --installation` then starts the installation. Before acknowledgment,
app routes refuse service and exact resume attempts fail. The operator acknowledges
the current deployment, digest, recovery ID and review hash, accepting possible
loss. One changed-findings refusal permits one recorded reinspection; a second
change invalidates the run. Acknowledgment leaves dispatch paused. Full application
rows, native status and recorded recovery observations must remain held through
another interval of at least 62 VM seconds.

Native container identity, fleet network, PID and process start cookie must match
the live baseline across the cold hold, controller startup, acknowledgment, signed
proof collection, and before backup or ordinary shutdown. After backup, the
qualifier verifies stopped volume writers and service exits. Final checks reject native child restarts, OOMs and
unexpected service exits. The gateway's documented SIGTERM exit of 1 is allowed.

## Explicit resume and loss boundary

Each cron resume must produce successful future work for both jobs before the
first post-resume application HTTP request. The qualifier then observes full
attempt, occurrence and result rows for more than two minutes after that success.
Rows belonging to old scheduled times must remain unchanged. A future wake alone
cannot establish that an old retry was discarded.

Pausing clears timer and retry identity. Resume schedules future work; missed
occurrences are not a retained backlog. Restoring older A demonstrably removes
later acknowledged data. External effects that happened after the snapshot can
be replayed by an application or operator; recovery acknowledgment accepts that
boundary and does not provide an external-effect deduplication guarantee.

Native SELECT and status requests can materialize resource cells and update
ownership metadata. Read-only observer mounts do not imply physically unchanged
object storage during active observation. Source archives are compared only with
fully stopped sources. Seven archived volumes are compared separately from each
installation's independent runtime-policy volume.

All 32 named volumes remain after the four installations' owned containers and
networks are removed. Privacy checks cover downloadable decoded artifacts, scoped
status, admin HTML/JSON, ordinary command diagnostics, all runtime logs and the
complete final receipt. Private operator inputs and physical snapshots intentionally
contain recovery credentials and are outside the public-surface claim.

## Scope limits

The expected identity binds logical storage and fleet identities; fresh network
placement does not change that hash. Native process keys are fresh after restore.
Those proofs do not distinguish a physical source from its clone. Actual Docker
bindings and explicit exclusion of source, sibling and descendant processes are
required in this local profile. Remote writers require operator exclusion.

This evidence does not qualify runtime upgrades, other architectures, active
backups, remote source fencing, Kubernetes scheduled recovery, Workflows, arbitrary
Durable Object alarms or CPU-exhaustion behavior. Replacement, failure, retirement,
offline builds and the complete selected-runtime acceptance audit retain their
own M11c gates.
