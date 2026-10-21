# Qualify guarded scheduled release replacement

The sealed replacement profile checks compatible migration overlap, publication
interruption and lost-reply retries on the signed release runtime. Its
[evidence receipt](evidence/m11c-sealed-replacement.json) applies to the recorded
Linux arm64 Docker layout and source fingerprints. Normal cron admission remains
closed; ordinary CLI scheduled restore and retirement remain refused.

Reproduction of this receipt requires a separate checkout of
[77cd27c](https://github.com/fogd-dev/fogd/tree/77cd27cf6d4837e6b37aa642aaa3ded68022f46f).
Current shared qualification helpers have changes outside this historical receipt.

## Run the private qualification

Use a Linux arm64 Docker engine with the checked runtime, storage and offline SDK
images already present. The [signed runtime binding](patches/celld-runtime-binding.md)
and [preboot guide](cron-runtime-preboot.md) describe their prerequisites. The
profile refuses mismatched dependency inputs and does not install dependencies or
pull images. Preserve the ignored native build receipt and matching source copy
required by its default-timing check.

From the repository root, choose a new private output directory:

```sh
node scripts/cron-sealed-replacement.mjs .fogd/sealed-replacement-run
```

The driver builds three private refresh releases with networking disabled, then
uses those exact fogd artifacts in a fresh two-fleet installation. Ordinary Void
builds and typechecks run separately in the same offline SDK image. Ordinary cron
artifact admission must still reject the generated declarations.

The runtime image contains fixed qualification programs and an immutable policy.
Commands select named releases in order; they cannot select source paths, executable
programs or publication gates. Before effects, the broker checks the durable exact
artifact approval and secret revision. Signed identity checks cover all four native
replicas; launch inventory checks cover the sealed image and read-only layout.

Require actual terminal exit zero and the final `sealed-replacement.json`, not a
progress line alone. The final receipt follows owned-project shutdown, retained
artifact hashing and source verification. No failure or cleanup-failure receipt may
be present. Inspect private runtime logs for fences, panics and storage exhaustion.
The driver stops its installation and removes its containers and networks while
retaining all seven volumes. Keep private evidence and application data outside git.

## Interpret the replacement evidence

A dispatch pause stops new callbacks without draining running work. The first
replacement applies compatible SQL while an old callback is held, then observes
that callback commit against the changed schema before publication. Its completion
must precede the native operation deadline.

The next replacement holds one callback before its business commit and its sibling
after commit. Both record progress after pause and migration. The driver correlates
the owning generation's exact swap/free log records with those durable heartbeats.
It measures the prior generation's adoption time and plans publication after its
maintenance tick to exercise late cleanup. The swap must still precede the
operation deadline. A phase that cannot fit this window is refused before
publication and is inconclusive, rather than evidence of a native failure. Attempt rows must remain
unchanged through both native expiry and the fixture's own hold deadline, then
remain unchanged after the old generation is actually freed. Whole-generation
cleanup follows the native maintenance interval; it is separate from the cron
cell's swap and the last observed application progress.
The saved sibling result survives; the other job remains visibly unfinished in the
browser. This does not establish termination of arbitrary external effects or a
general automatic replay contract.

A separate occurrence throws after a saved result. The driver observes the persisted
retry wake before its deadline, checks two attempts per job under the same owner
and original scheduled time, and requires one business result per job. A later
healthy occurrence and a full held minute complete the profile. Application keys
provide duplicate protection; this is not arbitrary external-effect exactly once.

The profile uses the checked runtime's native timing defaults without environment
overrides. Handler budgets and operation deadlines do not qualify per-worker CPU
quotas. See the receipt for measured completion, publication and retry margins.

## Check refusal after a failed observation

Run the companion regression in another new private directory:

```sh
node scripts/cron-sealed-replacement.mjs .fogd/sealed-replacement-refusal --failure-check
```

It advances to the middle release, holds the final approval before publication,
and invokes the same failure cleanup used by the full profile without releasing
the gate. It requires the broker's recorded gate deadline to expire and its actual
exit code to be one. The prior native version and approved artifact remain active;
the final approval is failed, with dispatch held and the journal paused. The release
file must remain absent. Final verification runs after shutdown and retains the
volumes. This regression does not replace the full positive profile.

The [historical replacement profile](cron-replacement.md) retains its original
source/runtime scope. Recovery, retirement, qualified runtime selection and ordinary
scoped admission have separate [M11c acceptance gates](m11c.md).
