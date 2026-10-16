Review complete. Verdict: **no blockers**. The code matches the spec and the response document's claims, unit tests pass 4/4, and I confirmed locally that Compose v2.38 JSON output escapes `$` as `$$`, so the single decode on backup and single encode on restore are correct.

**Verified against code**

- Backup order, stop-verification per volume, read-only snapshot mounts, manifest written last after fsync of every archive and the directory. Partial bundles fail with missing manifest, and reruns into the same directory fail on the existing directory.
- Restore verifies checksums, topology, and image identity format before any Docker effect, refuses same project name, refuses labeled or same-named volumes and networks, creates then never starts, verifies loaded image IDs, extracts, then runs a full `tar --compare` pass before writing the receipt. Retry after partial creation is refused.
- Drift check compares declared env, command, entrypoint, mounts, and volume ownership. Error strings carry no values.
- Both helper images are Debian with GNU tar and coreutils, run as root, so `-p`, `--compare`, and `sync -f` are valid.

**Should fix before merge, all one-liners**

1. `packages/cli/src/recovery/docker.mjs:20` leaks data on parse failure. On Node 26 a `JSON.parse` error message embeds a snippet of the input, so a malformed `compose config` or `inspect` reply can print a fragment of the resolved config, including credentials. Wrap the parse and throw a fixed message:
   ```js
   export const json = async (args, options) => { const text = await docker(args, options); try { return JSON.parse(text); } catch { throw new Error(`Docker ${args[0]} returned unreadable JSON`); } };
   ```
2. `backup.mjs:25` and `restore.mjs:28,31` should add `--numeric-owner` to every tar invocation. Today ownership round-trips only because both sides resolve names through the same pinned image's passwd. Numeric ids remove that dependency at no cost.
3. `backup.mjs:25` snapshot helper drops all caps. Any future file not readable by root without `CAP_DAC_READ_SEARCH` (a non-root 0600 file written by an app) makes backup fail loudly, which is correct but avoidable. Add `--cap-add DAC_READ_SEARCH` there, and `--cap-add FSETID` on the extract helper so setgid bits survive extraction instead of failing the compare pass.
4. `backup.mjs:33` records nonzero exits and OOM kills only in the manifest. The spec says a killed replica must be reported. Print one warning line when any recorded exit is nonzero or `oomKilled` so the operator sees crash-consistency at backup time, not only when reading the manifest.

**Non-blocking notes**

- Container stdout logs are not in the bundle because they live in Docker's json-file logs, not volumes. The spec line about preserving local logs alongside the bucket should either be qualified in `docs/m8a.md` or satisfied by dumping `docker logs` per service to owner-only files in the bundle.
- Stderr from every Docker call is discarded, so a missing credential in `.env` surfaces as "Docker compose failed (1)". Safe choice given the no-echo contract. Worth one sentence in the docs telling operators to rerun `docker compose config` themselves for diagnostics.
- Retry after a failed image load leaves an empty output directory and the next attempt dies with a raw `EEXIST` mkdir error. Cosmetic.
