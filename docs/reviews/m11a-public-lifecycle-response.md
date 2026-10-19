# Canonical update and retirement review response

Claude independently reviewed each probe and found no blocking bug. Both Docker
runs completed after review began. The reviews identify useful tighter preconditions;
these were added without claiming the strengthened scripts were fully rerun.

For updates, the probe now requires an empty stored queue, an unapplied 0002 migration,
and zero attempts on the pending job after approval. Saved pre/post snapshots confirm
0002 was absent/present respectively, and the saved migration checkpoint shows zero
pending-job attempts. Final cleanup preserves both errors if the test and pause fail.

For retirement, require a nonqueue neighbor in a different fleet with nonempty data,
check the generated replacement prefix explicitly, wait for gateway readiness before
checking 404, and verify the submitted replacement's app/status before approving.
Record a digest of the retained object's key/size/byte-hash list instead of a literal
success boolean. A further read of the running target confirmed the source-prefix
hash list still matches and the replacement prefix differs.

The nonempty-neighbor assertion exposed a real evidence limit: this run's neighbor
returned an empty list. Its availability is qualified; nonempty neighbor data
preservation is not. The public evidence, report and roadmap mark that gap. The
stricter probe must be rerun with a populated neighbor before closing that check.
Previous three-fleet qualification is separate evidence, not a substitute for this run.
