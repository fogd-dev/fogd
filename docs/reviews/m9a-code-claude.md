Key names only, no values. I have everything I need.

## M9a Kubernetes review

**Verdict: not mergeable as the "experimental deployment" gate yet.** The renderer and secret handling are sound. Two blockers are around teardown data loss and the evidence not having come from the committed runner. Everything else is a fix-now-or-document item.

### Blockers

1. **Default teardown destroys all durable state.** The Namespace is the first item in `manifests.json`, so the obvious inverse of the apply command, `kubectl delete -f manifests.json`, deletes the namespace. Namespace deletion cascades to every PVC regardless of the StatefulSet retention policy, and kind's default storage class reclaims with Delete. Acceptance item 5 requires teardown that retains state by default. Move the Namespace to its own file, and document that only StatefulSet and Service deletion is the retained-state teardown. (`packages/cli/src/kubernetes/render.mjs:11`)

2. **The recorded evidence did not come from the committed runner.** The spec requires the explicit runner to create the named cluster. The live `.fogd/m9a` has a hand-written `kind.yaml`, no `source.env`, no `certificate/`, no `cluster.json`, and uses image tag `m9a-1c20622` while `kubernetes-setup.mjs` produces `fogd-runtime:fogd-m9a`. The setup script has never run end to end. Re-run from `kubernetes-setup.mjs` before citing `evidence.json`, or the report describes a procedure that was not exercised.

3. **Infrastructure settings silently dropped, not recorded.** The compose topology honours `FOGD_MAX_PENDING`, `FOGD_MAX_PENDING_PER_CREDENTIAL`, `FOGD_MAX_ARTIFACT_BYTES`, `FOGD_MAX_UPLOADS`, `FOGD_BUCKET_ENDPOINT`, `FOGD_CELLD_*`, and `FOGD_SLOT_n_{A,B}_{ID,HOST}`. The renderer ignores all of them, yet copies every `FOGD_*` value into `installation.env`, so an operator who sets them sees them persisted and believes they apply. The live installation.env contains exactly these ignored keys. Either plumb the controller limits through `platform()` (they are process env, trivial) and reject the compose-only ones with a clear error, or at least do not persist them. The spec says to record any infrastructure-only configuration change. (`packages/cli/src/kubernetes/render.mjs:32`, `workloads.mjs:23`)

### Should fix before calling M9a experimental-complete

4. **Gateway may hold stale replica IPs after pod replacement, and failover masks it.** workerd `external` services resolve the hostname when the config loads. After `slot-2-0` is replaced with a new pod IP, the gateway health check for that backend fails and traffic silently falls to `slot-2-1`. The smoke passes because the gateway health-checks and fails over, then replaces `workerd-0` anyway. I could not verify workerd's resolution behaviour read-only. Add a check after replica replacement that the gateway can still reach the replaced replica specifically, for example by confirming both replicas receive requests, before replacing the gateway. (`scripts/kubernetes-smoke.mjs:56`)

5. **Apply order and wait race.** Secrets apply after workloads, so every pod starts in CreateContainerConfigError until the second apply. And `kubectl wait` with a label selector fails with "no matching resources" if the StatefulSet controller has not created pods yet. Apply secrets first, and wait on the StatefulSets rather than the pods. (`scripts/kubernetes-smoke.mjs:13`)

6. **No committed operator documentation.** Nothing in `docs/` describes the Kubernetes topology, the Secret-not-encrypted-at-rest caveat the spec explicitly requires, the "never force-delete pods" rule from the response, the OnDelete manual pod-cycling procedure, or the teardown. `fogd kube render` prints one line. The response document references rules that exist nowhere an operator will read them.

7. **No image identity binding for MinIO.** The evidence shows the MinIO `imageID` reported by the kubelet as an `import-2026-10-16@sha256:...` artefact of `kind load`, not the tag. The config ID check still passes, which is the right comparison, but note in evidence that `reported` is not a stable identifier for kind-loaded images so nobody later treats it as one.

### Confirmed good

- **Secrets:** no credential values in `manifests.json`; only key names via `secretKeyRef`. Controller gets admin and gateway secrets, workerd only the gateway token, fleets only bucket keys. TLS key material lives in a separate Secret mounted read-only. Private files are mode 0600 under ignored `.fogd/` and refuse overwrite with `wx`. Build subprocess env filters tokens and passwords.
- **Ownership:** single-replica OnDelete StatefulSets for controller and MinIO, retained PVCs, ordinal identities, required per-fleet host anti-affinity, no liveness probe on celld, 180s startup headroom over the 15s lease delay, 60s grace above compose's 45s, service-account mounting disabled everywhere.
- **DNS and startup:** `$(CELLD_NODE)` expands from the fieldRef env var, headless fleet Services publish not-ready addresses, controller node validation accepts dotted names, bucket initializer blocks controller and fleets as init containers.
- **Recovery refusal:** `requireDocker` guards `up`, `backup`, and the TLS import and check paths. `restore` does not read the env and only accepts Docker bundles, so it cannot be pointed at this topology. Unit test covers the refusal.
- **Isolation:** client asserts current-context, exact node names, and kind cluster labels on each node container before any mutation. Setup refuses an existing cluster name and writes only a repo-local kubeconfig.

### Minor

- No `runAsNonRoot` or `runAsUser`; containers run as root with capabilities dropped. Acceptable for trusted workloads, but call it out alongside the Secret-at-rest caveat.
- MinIO console on 9001 listens inside the pod but is not in the Service. Harmless; same as compose.
- The `cluster.json` written by setup records the kind image but not the runtime image IDs. The smoke's `evidence.json` does, so fine as long as the runner is the thing that actually runs.