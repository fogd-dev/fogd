# Queued Docker retirement review response

Claude reviewed the design and implementation with repository access. Both runs
completed successfully within their fifteen-minute deadlines. Gemini was not rerun
because the previous review attempts exhausted its quota.

Accepted the design findings: validate source evidence before transformation, write
final state once, account for retired queue history, redact nested private versions,
and probe required runtime capabilities before target creation. Retained the complete
private audit deliberately; admin inspection projects only safe summary fields.

Accepted the implementation suggestions: validate the generated retirement state
against replacement slots before Docker effects, reject operational queue fields on
all tombstones, and give delivery state without queue declarations one explicit
refusal. Added tests for non-queue retirement with queued survivors, unnecessary
stop-work flags, and runtime-capability selection. A real older queue-recovery
image was refused before target containers were created.

Local Docker evidence confirms pending target retirement, fresh replacement queue
and database, new work processing, unchanged retained prefix objects after replacement
traffic, survivor acknowledgment/resume, and a subsequent backup excluding retired
queues. The first restore attempt exhausted Docker's local address pool; removing an
unused stopped fixture's containers/networks while retaining volumes allowed a fresh
target retry. No source or snapshot was deleted.

Remaining acceptance work: a live zero-live-queue tombstone backup and restore, a
source-side prefix fingerprint before retirement, and the complete public deployment
flow. Unit tests cover zero-live metadata restore. The existing object comparison
starts after target startup and must not be described as a source-to-target comparison.
Public queue admission remains closed. These limits stay on the next-work list.
