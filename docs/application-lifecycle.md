# Application lifecycle and capacity reclamation

Fogd needs reversible app archival as well as permanent retirement. This contract
tracks [issue 8](https://github.com/fogd-dev/fogd/issues/8); reversible archival and
preview expiry remain unimplemented. The delivered first increment is a verified
retirement review and optional execution binding on the existing stopped recovery
workflow. It does not turn retirement into archival.

## State meanings

The [glossary](../GLOSSARY.md) keeps execution, retention and capacity distinct.

| State | Execution | Fleet capacity | Restoration rights | Status |
| --- | --- | --- | --- | --- |
| HTTP paused | New HTTP requests withheld; background controls remain independent | Still occupied | Exact reconciliation/resume under existing controls | Implemented |
| Installation stopped | All installation writers confirmed stopped | Assignments retained | Start the same installation or use stopped recovery | Implemented |
| App archived | App ingress and background writers fenced; data retained under an archive identity | Reusable only after verified completion in a fresh target | Explicit restoration of the same app from its retained archive | Future protocol |
| Preview expired | Preview authorization ended; writer confirmation remains a separate fact | Occupied until writers are fenced and reclamation completes | Determined by an explicit preview retention policy | Future issue #2 integration |
| App retired | Old app cannot execute or reclaim its name in the new installation | Released fleet has fresh storage authority | Independent app restore unsupported; an older whole snapshot can resurrect prior state | Implemented stopped retirement |

HTTP pause is not proof of quiescence. A desired stop, expired authorization or
uncertain native reply cannot manufacture a free slot. Retained artifact bytes,
application data and available fleet slots remain separate measurements.

## Delivered: review stopped retirement

`fogd retire plan` verifies a durable snapshot against an independently selected
qualified runtime and source identity. It returns versioned JSON describing exact
app/release identity, snapshot hash, target project/network binding, whole-installation
downtime, stopped target services, survivor holds and retained data.

The report shows verified archive-member bytes, zero disk reclamation and one
fleet slot released only after verified target completion. It excludes credentials,
secret revision values/IDs, native node identities, bucket prefixes and raw configuration.
It leaves live source status, cached image availability and target availability
explicitly unobserved. The review is not a capacity reservation or a live-health
check. A fingerprint verifies the selected files, not publisher trust.

`--expected-plan SHA256` makes execution recompute that review before Docker
verification, fencing or allocation. Changed snapshot identity, app/digest, target
project, network placement or background-loss consent refuses before mutation.
Generated replacement IDs and timestamps are not reserved by planning. The output
directory is chosen at execution and retains its independent freshness/path checks.
The existing coordinator still checks source writers and snapshot bytes repeatedly,
keeps partial targets stopped/incomplete and requires explicit survivor recovery.

Validation covers stable reviews across independently generated replacement IDs,
changed intent, private-value exclusion, real CLI planning without Docker, blocked
stale execution, and matching execution through the existing fenced coordinator.
Special-file metadata refuses before opening a named pipe. A
[read-only native v8 snapshot check](evidence/operator-retirement-review-v8.json)
rehashes all 11 retained snapshot members, confirms stable reviews and stale refusal
without Docker, and verifies all 117 image source pins. It executes no new native
retirement. The
[retirement guide](retirement.md) supplies the operator commands.

## Archive protocol implementation in progress

The source-only [archive state protocol](../packages/platform/src/app-archive.mjs)
projects a verified app into a name-reserving archive, then restores that same app
into unassigned capacity behind a pending recovery gate. It binds the retained
snapshot, release, fleet namespace, native identities and storage origin. It keeps
current credential records, unrelated apps, release history and artifact references.
Queued and scheduled metadata retain their paused receipts for later reconciliation.

This projection does not stop writers, copy native data or change route authority.
No CLI, controller startup path or shipped runtime admits the new capability.
Existing runtimes reject it. The filesystem coordinator, route publication,
secret-vault checks, background recovery/rebinding, explicit approval and native
archive/reuse/restore acceptance remain to be implemented before operator use.

## Remaining archive protocol

Archive support needs a separate immutable runtime and native acceptance before
admission. Implement it as an app lifecycle capability with these conditions:

- Bind the archive to the exact app, release, source storage identity and verified
  retained data. Reserve the archived app's name; another app cannot adopt it.
  Validation: changed identity, data, capability or release refuses restoration.
- Fence app ingress and background writers before releasing capacity. The initial
  supported workflow requires whole-installation downtime and fresh target storage.
  Validation: interrupted or uncertain reclamation leaves capacity occupied or the
  target incomplete; concurrent admission cannot reuse its authority.
- Retain all surviving apps, decision history, protected artifacts and recovery
  references. State the retained-data policy before mutation. Validation: archive A,
  use its capacity for B, then restore A into available fresh capacity; A's saved
  records survive and B's records remain unchanged.
- Require explicit reconciliation/approval before restored code or background work
  runs. Current operator authority governs credentials; restoration cannot silently
  resurrect revoked global credentials. Validation: cold restore is inert and old
  queued/scheduled work needs its recorded recovery acknowledgment and resume.
- Report archive identity, execution uncertainty, retained bytes and capacity as
  separate stable fields. Validation: lost replies and interrupted cleanup never
  produce a completed/free result; replayed or conflicting archive identities refuse.

Preview execution/expiry stays in [issue 2](https://github.com/fogd-dev/fogd/issues/2).
It must reuse the same writer-fencing and reclamation rules rather than invent a
second cleanup mechanism. Live slot reuse, automatic data erasure and unlimited app
density remain unsupported. Issue 8 stays open until the archive protocol, mutation
results and native interruption/recovery gates are implemented and verified.
