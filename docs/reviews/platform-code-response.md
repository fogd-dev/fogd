# Platform implementation review response

Claude completed a source-grounded implementation review in about seven minutes.
Streaming tool events confirmed execution throughout. The original findings are
preserved in [platform-code-claude.md](platform-code-claude.md).

Accepted and tested:

- Reject a shrinking migration ledger. Preserve known applied hashes and the
  uncertain checkpoint until an authoritative ledger contains those migrations.
- Supersede other pending, failed, and previously active requests when an app's
  approval succeeds. Retrying a stale request cannot silently roll back code.
- Preserve app resources, migrations, and active-release history when duplicate
  bucket ownership markers appear. Quarantine the app and reserve every occupied
  slot rather than replacing its metadata or considering the extra slot free.
- Record and display the reason for quarantine, distinguishing missing controller
  state from missing/mismatched bucket ownership or duplicate markers.
- Bound replica readiness to a three-minute overall deadline. Controller operations
  serialize, so submissions can wait behind activation; the CLI allows fifteen minutes.

Resource declarations remain frozen after the first activation in v0, including
additions. A future explicit resource-change operation must cover bootstrap ordering,
identity preservation, and migration recovery. The README/report now state this limit.

Rejected artifacts remain available for administrator inspection and audit. Automatic
pruning and a total artifact-storage quota are deferred and listed as operational gaps.
The pending-request cap does not bound lifetime artifact storage.

A local review also found that reserved paths should be checked after URL decoding.
The gateway now rejects encoded internal paths. Tests verify that and ensure a sent
mutation is never replayed after an ambiguous response failure.
