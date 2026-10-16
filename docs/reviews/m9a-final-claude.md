## M9a final review

**Verdict: one concrete blocker remains. It will fail the m9final2 smoke on its first wait.** Everything else from the prior review is fixed or honestly documented.

### Blocker

**`kubectl rollout status statefulset/...` rejects OnDelete StatefulSets.** `scripts/kubernetes-smoke.mjs:16` waits on rollout status for all five StatefulSets, and `resources.mjs:18` sets `updateStrategy: OnDelete` on every one. kubectl's StatefulSet status viewer returns an error for any strategy other than RollingUpdate. I confirmed the string is present in the installed binary:

```
$ kubectl version --client   → v1.37.1
$ strings $(command -v kubectl) | grep "rollout status is only available"
rollout status is only available for %s strategy type
```

The m9verify smoke that passed used the pre-amendment wait (`kubectl wait --for=condition=Ready pod ...`, visible in `.fogd/m9verify-smoke.log`), so the amended line has never executed. The m9final2 run is still in `kind load` and has not reached it.

Fix: replace the rollout-status loop with a wait that works for OnDelete, e.g. `kubectl wait --for=jsonpath='{.status.readyReplicas}'=N statefulset/NAME --timeout=240s` (N = 2 for fleets, 1 otherwise), or keep the pod wait but poll until the pods exist first. Apply the same to the two `rollout status` calls at `kubernetes-smoke.mjs:66`.

### Verified fixed

- **Namespace teardown.** `namespace.json` is a separate file (`render.mjs:26`); `manifests.json` contains no Namespace (unit test asserts it). Docs tell operators to scale to zero and never delete the namespace file as teardown.
- **Ignored settings.** `FOGD_MAX_PENDING*`, `FOGD_MAX_ARTIFACT_BYTES`, `FOGD_MAX_UPLOADS` are now passed to controller/gateway; `FOGD_CELLD_*`, `FOGD_MAX_REQUESTS`, `FOGD_MAX_RESIDENT_CELLS`, `FOGD_MAX_REQUEST_BODY_BYTES`, `FOGD_MINIO_*` reach the containers; `FOGD_BUCKET_ENDPOINT` other than in-namespace MinIO is refused; `FOGD_SLOT_n_{A,B}_{ID,HOST}` are excluded from `installation.env`. Still persisted but meaningless on Kubernetes: `FOGD_HTTP_PORT`, `FOGD_ADMIN_PORT`, `FOGD_BIND_ADDRESS`, `FOGD_APP_HOST`, `FOGD_ARTIFACT_DIR`, `FOGD_NODE_*`. These are host-publishing and local-profile knobs. Minor, not blocking; a one-line addition to the exclusion regex would close it.
- **Stable per-replica addresses.** `workloads.mjs:27` creates ClusterIP Services named `slot-N-i` with `statefulset.kubernetes.io/pod-name` selectors and `publishNotReadyAddresses`. The gateway builds backends from `FOGD_SLOTS` nodes as `slot-N-i:8080` (`serve.mjs:18`) and celld advertises `$(CELLD_NODE):8081`, both resolving to the stable Service, not the pod IP. Headless `slot-N` Service still governs StatefulSet DNS. Unit test checks the selector and that these are not headless.
- **Failover masking.** After replacing ordinals zero, the drill scales both fleets to one replica, waits for the `-1` pods to be deleted, then asserts notebook data and the account session before scaling back. With `-1` gone, a 200 can only come through the replaced `-0`. `whenScaled: Retain` keeps the `-1` PVCs, and the later claim-identity comparison would catch any loss.
- **Apply ordering.** Namespace, then Secrets, then workloads. Correct.
- **Docs.** `docs/kubernetes.md` covers Secret-at-rest caveat, root containers, OnDelete manual pod cycling, force-delete hazard, retained-PVC teardown, kind image label instability, and the lateral-network regression.

### Limits of this review

- Read-only. I did not run the smoke or inspect the live clusters, so the stable-Service claim rests on reading `serve.mjs` and the manifests, not on observing workerd after a pod IP change.
- No completed run of the amended runner exists. `m9final` died in `kind load` with "no space left on device" on the worker node (environment, not code). `m9final2` was still loading images when I looked. Evidence from m9verify covers the old wait logic only.
- Did not re-verify kubelet behaviour for `$(CELLD_NODE)` expansion or the init-container bucket wait; those were confirmed in the prior review and are unchanged.