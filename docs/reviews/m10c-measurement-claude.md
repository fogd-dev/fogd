Review complete. Tests pass (4 of 4) and the live Compose project on this host matches the inventory the capture expects (minio, controller, workerd, four slot replicas, exited bucket-init).

**Verdict: no blockers.** Nothing in the slice mutates project state, follows redirects, disables TLS, or records credentials. Two medium findings are worth fixing before commit. The rest are optional.

## Medium

- **TLS guard test proves nothing.** `packages/cli/test/capacity-load.test.mjs:28` only asserts the process rejects. Without the guard, the run against `https://localhost/` would fail every connection, write the report, exit 1, and still reject. The test passes either way, just 120 seconds slower. It also uses a relative `unused.json` in the repo cwd. Fix: pass `--seconds 1`, use a tmp output path, and assert the output file does not exist afterward. The guard throws before the write, the unguarded path writes.
- **Output path is only checked after the capture.** `scripts/capacity.mjs:36` opens with `wx` at the end. A 6 hour run (360 samples at 60 s) dies on EEXIST with all data lost. Open the handle with `wx` before the loop and write to it at the end. One line moved.

## Low

- **"Untouched" claim is slightly over-stated.** `scripts/capacity.mjs:20` runs `docker exec` on the measured controller to read VM meminfo. State is unchanged, but code executes inside a measured service. Say so in `docs/capacity-measurement.md:11` rather than "leave containers unchanged". The approach itself is fine. `docker info` lacks swap, and an ephemeral `docker run` would be more invasive.
- **Prefix ID matching is unnecessary slack.** `scripts/capacity/metrics.mjs:24` accepts `c.id.startsWith(row.ID)` though `--no-trunc` always yields full IDs. `find` returns the first prefix match, so a short ID could bind to the wrong container. Use strict equality.
- **CPU percent window not stated.** Each `docker stats --no-stream` CPU value is a daemon-computed delta over roughly one second, not an average over `--interval`. The "sampled" caveat is true but the guide should say the window so nobody reads cpuMeanPercent as a 5 second average.
- **Missing `--url` gives a bare "Invalid URL" TypeError** at `scripts/capacity/load.mjs:7` instead of the usage line. Trivial.
- **Report records the full path.** `url.href` in the load report would retain any path-embedded token. Query strings are already rejected. Worth one sentence in the guide since operators pick the endpoint.

## Optional

- Metrics test covers restart-count change but not container replacement (id or startedAt change) nor malformed `MemUsage`, both of which the docs claim are rejected. Two cheap asserts.
- Review response item 5 asks warm measurements to be labelled by workload history. Both reports rely on filename and timestamps for that. A `--label` string field is a one-liner if you want it in the artifact rather than the guide.

Things I checked and found correct: wall plus monotonic timing and gap rejection, inventory rejection of incomplete or duplicate fleets and running initializer, per-sample re-inspection via `unchanged`, `redirect: 'error'`, per-request abort timeout covering body reads, 1 MiB body bound cancelling the stream, closed-loop request ceiling, `wx` plus 0600 on both outputs, project name validation before use in the label filter, and the `pnpm test` glob and `scripts/check.mjs` both picking up the new files.