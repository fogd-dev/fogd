**Verdict: no remaining blockers.** The three code-review blockers are fixed in the adapter and each has a unit test. The limits below are nits and evidence gaps, not defects that change the acceptance decision.

**Verified fixes**

- **Image archive.** `packages/cli/src/kubernetes/recovery/image-archive.mjs` checks the legacy manifest tag set exactly, requires each Config path to match the recorded ID, hashes the config bytes, and when an OCI index exists checks annotations, descriptor digest, and config digest. It runs in backup after save and before the completion manifest, and in restore before any cluster access. Duplicate or missing tar members fail closed. Load happens only for missing tags, conflicting local or node tags are refused, and identity is rechecked after load on host and nodes.
- **Empty claims.** `pods.mjs:58` refuses a non-empty claim before extraction. Claim spec is allowlisted to three keys, storage class must be local-path with WaitForFirstConsumer, access mode must be RWO, and compare uses numeric ownership.
- **Stop observation.** The watch is established before scaling, fails closed if all expected UIDs are not seen within fifteen seconds, records terminal state per UID, and classifies anything not exit 0 Completed as uncertain. Restore revalidates the classification. On-disk evidence matches: the reviewed snapshot shows six stateful pods exit 0 Completed and workerd exit 1 excluded. The node-interruption attempt shows complete false, three uncertain pods, and no manifest.
- **Malformed snapshot.** File set, checksums, format, namespace label, workload shape, claim spec, secrets, and stop evidence are all validated before a connection is opened.
- **Process hygiene.** The only shell string is a fixed literal. All other invocations are argv arrays. Timeouts escalate SIGTERM to SIGKILL, spawn ENOENT does close the promise, and the only delete path is the helper pod without force.

**Limits and nits, none blocking**

- The empty-claim check trims find output, so a whitespace-only filename would pass. Fresh local-path directories cannot produce one.
- Bundle image tags are not shape-checked on restore. A tag beginning with a dash would reach docker, crictl, and kind as an option. Bundles are operator-private. A short regex in `validateInventory` closes it.
- Uncertain stateful exits flag and warn but still complete the manifest. This matches the response and docs. Confirm that is the intended policy.
- A watch process dying mid-stop is noticed only at finish. Affected pods then become uncertain, which is the conservative outcome.
- The read-only backup helper drops all capabilities, so root cannot read other-UID mode 0600 files. Tar would fail closed. The drill passed, so current layouts are fine.
- A helper delete failure in the finally block masks the callback error.

**Evidence limits**

- The two reviewed negative reruns on disk before today did not pass. Both died in the drill script, not the adapter, on the fifteen-minute kubectl timeout. The first died after the node restart, the second before the foreign-writer stage. The timing gap and the current run's name suggest machine sleep.
- The run described as passing full negatives is the one from Oct 16 at 16:48, which predates stop observation.
- The current run has cleared corruption, occupied-target, foreign-writer, and node-interruption stages and is in the isolation stage with port-forwards up. Its result had not arrived at the time of this review, so negatives on current code are not yet confirmed.
- Large volumes against the fifteen-minute ceiling remain unqualified. Remote registries and non-kind clusters are out of scope as documented.