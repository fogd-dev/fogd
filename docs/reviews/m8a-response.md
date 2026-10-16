# M8a recovery review response

Claude's [design review](m8a-claude.md) identified configuration drift as a blocker:
the current Compose file may differ from the containers that wrote the data. Backup
now compares declared environment, command, entrypoint, mounts, and volume ownership
against Docker inspection before stopping anything. Errors do not echo credentials.
The original [specification](../m8a.md) remains the review baseline.

The implementation already stops all replicas together, checks every volume for
running users, uses read-only snapshot mounts, creates Compose-owned target volumes,
checks labeled resources and exact target names, and pins image IDs with no build
section or pull. The first full restore demonstrated that Docker Compose accepts
these image IDs directly; additional mutable tags are unnecessary. Restore verifies
all image IDs after load and compares extracted files against every original archive
before writing the completion receipt. Archive output and completion records are
synced to disk.

Docker's resolved JSON config already escapes literal dollar signs. Backup decodes
that representation once into its private config; restore encodes it once when
writing the generated Compose file. The regression includes a gateway token containing
literal shell-style expressions. Unit tests cover round trips and drift refusal.

This slice qualifies replacement at the same application origin with the source
stopped. Keeping the original published ports preserves the local app/session
contract; concurrent source/clone hosting is outside this acceptance. The generated
configuration names a fresh private MinIO volume, so the two installations cannot
write to the same bucket. Separate ports and remote ingress policy remain follow-up
work. No claim of simultaneous failover or global availability is made.

The extended smoke includes forced stops of both notebook replicas and controller
termination during an accounts approval. The restore must retain acknowledged data,
mark the interrupted approval failed, preserve its secret revision, avoid quarantine,
and permit explicit retry. Container exits are recorded in the backup manifest;
nonzero exits describe crash recovery, not a clean checkpoint.

Gemini's [attempt](m8a-gemini.md) ended with a provider quota error after source
inspection. No Gemini verdict is claimed. Continue with Claude implementation review,
unit checks, and real Docker recovery evidence.

Claude's [implementation review](m8a-code-claude.md) found no blockers and recommended
four hardening changes. Docker and bundle JSON parsing now use fixed errors without
input snippets; tar uses numeric owners; read-only snapshot helpers can read files
owned by non-root users, and extraction preserves setgid bits; backup prints abnormal
persistent-service exits as well as storing them. The archive includes celld durable
logs, not Docker container stdout logs. Operator diagnostics remain private; Docker
stderr is deliberately not copied into CLI output.

The final crash drill passed after all four hardening changes. A separate failed
attempt exercised Docker network-pool exhaustion: restore created no running target
and wrote no completion receipt. Old test containers/networks were removed without
deleting their volumes; a new target then completed. This was an environment-capacity
failure, not a reason to reuse a partial target or alter global Docker configuration.
