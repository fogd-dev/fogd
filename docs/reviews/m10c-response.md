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
