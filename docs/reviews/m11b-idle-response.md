# Idle eviction review response

The probe checks `CELLD_IDLE_EVICT_S=5` in both running replica containers and
requires observed eviction within 15 seconds. It records the observed socket
count and closes, acknowledgment time, restored owner and whether ownership moved.
The ordinary-policy observation lasts 30 seconds and also requires a subsequent
acknowledged edit on the same connection. Readiness checks use celld's health
endpoint before each phase and after restoring the original configuration.

The checklist message handler requires valid room parameters, which native Void
restores from its socket attachment. Lost attachments fall back to empty parameters
in the SDK and cannot satisfy this guard. The test then requires a single revision
advance after eviction, with the first item retained and checked.

The first review did not locate the local Rust checkout and therefore could not
validate residency semantics. Its claim that no Rust source exists here is
incorrect. `.upstream/celld/crates/logic/lib.rs` defines `Resident` as active or idle
in memory and `Dormant` as out of memory but still owned. Its `residents()` reports
Resident/EnsuringDurability cells; `evict_idle()` initiates local eviction rather
than handoff. The passing observation must also show a dormant cell on the prior
owner. A focused follow-up review receives those exact paths.

The generated Compose file contains credentials, stays in the private output
directory, and is removed first during cleanup. Only explicitly selected JSON
evidence is copied into documentation. A process killed before cleanup may leave
that private file for diagnosis. Other fixture services and all volumes remain.
