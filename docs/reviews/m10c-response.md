# M10c review response

The [Claude design review](m10c-design-claude.md) supports measuring first and
identifies recovery inventory as the main expansion risk. The original
[proposal](../m10c.md) remains the review baseline; these amendments govern work.

## Accepted changes

1. Separate measurement, recovery inventory generalization at two fleets, and
   enabling a third fleet. Each receives its own validation and commit. No
   three-app support claim precedes the full recovery and retirement drill.
2. Verify `compose.json` against the manifest before deriving a backup's expected
   file set. Derive service, volume, archive, image, and retirement inventories
   from the same validated topology. Audit `docker.mjs`, `bundle.mjs`,
   `inventory.mjs`, `backup.mjs`, and `retirement-plan.mjs` together.
3. Preserve shutdown ordering: gateway/controller, all replicas, then bucket.
   Backup already derives its replica stop list from volume names; the topology
   validator must make that correspondence explicit.
4. Label Kubernetes as experimental local-kind evidence and retain its two-fleet
   boundary. Docker expansion does not qualify a larger Kubernetes installation.
5. Label warm measurements by workload history. Record VM CPU/memory, operating
   system, cgroup version, swap availability, and unrelated container count.
   Sample wall and monotonic time; reject long observation gaps. CPU 100% means
   one full core, not the entire VM. TLS uses `NODE_EXTRA_CA_CERTS` at process start.
6. Expansion comparison keeps workload per app fixed. The initial warm baseline
   exercises one existing D1/R2/DO read endpoint; it does not satisfy the later
   two-versus-three fleet comparison or cold-start measurement.
7. Show configured ceilings separately from observed usage. Retained source and
   fresh target volumes coexist during recovery and retirement, increasing disk
   requirements in addition to retained bundles.

## Clarifications and deferred choices

The observation tool measures labeled running services without a configuration
file. It rejects incomplete fleets and a running initializer; the exited one-shot
initializer is excluded. This is an observation, not backup preflight or a claim
that live environment and mounts match a supplied configuration. Reusing backup's
full configuration validator would require operator credentials and an additional
configuration input without improving that measurement claim.

A Compose profile is a candidate alternative to generation, not yet the choice.
Profiles still appear in resolved Compose configurations and need explicit
inventory treatment. Compare a single-source generator against profiles when
implementing topology selection; do not introduce two independent definitions.

The current memory ceilings total 3584 MiB; a third fleet adds 1024 MiB. The current
CPU ceilings total 8 cores and a third fleet adds 2. These are ceilings, not
reservations. The observed Docker VM has 10 CPUs and about 15.6 GiB memory; the
review's suggestion that these ceilings exceed most laptop capacities is not
supported by this evidence and is not adopted.

## Measurement implementation review

[Claude's code review](m10c-measurement-claude.md) found no blockers and two medium
issues. The TLS test now targets a responding local fixture and verifies refusal
before any report is created; removing the guard makes it fail. Both tools reserve
the private output file before collecting metrics or sending requests, preventing
late loss when an output path already exists. Failed captures can leave incomplete
files; the guide distinguishes those from completed reports.

Accepted low-severity fixes use exact container IDs, document the short CPU sample
window and controller meminfo read, sanitize invalid URL diagnostics, and explain
that endpoint paths are retained. Tests also cover replaced containers, changed
start times, and malformed memory fields. Workload history remains in the recorded
experiment description rather than a new free-form CLI label.

## Recovery inventory implementation

The next slice retains exactly two fleets while deriving service, replica, volume,
archive, image, and retirement inventories from one layout. Bundle verification
checks `compose.json` before parsing it and deriving the required archive set.
Validation checks local replica addresses, disjoint storage prefixes, distinct
node identities, local bucket bindings, expected volume mappings, and fleet
network membership. Shutdown still stops gateway/controller, every replica, then
the bucket and initializer. Kubernetes configuration and recovery are unchanged.

The existing stopped bundle format and optional TLS archive remain supported.
Additional fleets remain refused until expansion qualification passes. ADR 023
records the intentionally limited local layout and the cost of refusing custom
Compose topologies rather than guessing which additional writers need capture.

[Claude's layout review](m10c-layout-claude.md) approved the slice without blockers.
Accepted findings add explicit error matchers to negative tests and an assertion
that retirement output passes recovery validation. Layout derivation is hoisted
out of mount loops and reused during backup. The recovery guide explicitly records
stricter host/prefix overrides; node identity overrides remain supported.

On 2026-10-19, both retained M8b2 TLS and M10b snapshots verified under the new
code. A new stopped backup of the retired installation completed in 29.1 seconds;
fresh-volume restore completed in 13.8 seconds, excluding startup. Both app routes
served afterward, and the one-entry D1/R2/DO response matched byte for byte. The
source stayed stopped. Three fleets remain unqualified.
