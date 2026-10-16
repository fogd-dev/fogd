I have everything I need. Here is the review.

## Verdict

The spec is directionally right (plain manifests, StatefulSets, kind first, honest node-failure boundary). It is too wide for one slice and it misses five code-level facts that will break a naive port. Fix the blockers below, cut the scope to the first slice, and move recovery to M9b.

## Blockers found against the code

1. **The controller and gateway address replicas by bare hostname, and pod DNS vanishes when a pod is not Ready.** `backend.mjs:46-58` polls `http://${node}:8081/reload` and `:8080/.well-known/celld/health`; `serve.mjs:18` bakes the same names into workerd `external` services. The headless slot Service must set `publishNotReadyAddresses: true`, or a replica that is restarting (or whose readiness probe fails) becomes unresolvable exactly when the controller and its peer need it. Without that flag, `ready()` fails on every replacement and recovery reads between peers break.

2. **Controller must be `replicas: 1` with `strategy: Recreate`.** State is a single `state.json` serialized by an in-process queue (`controller.mjs:19-23, 49`) and the admin CSRF token is per-process (`http.mjs:23`). A default RollingUpdate Deployment runs two controllers against one PVC during every rollout. Same for MinIO and the gateway is stateless so it can roll.

3. **Shared profile and TLS are mandatory in Kubernetes, not optional.** `transport.mjs:10-11` throws unless the public bind address is loopback or profile is `shared`, and `shared` requires `FOGD_TLS=1` and an empty `FOGD_DEPLOY_TOKEN`. So the renderer must emit `FOGD_PROFILE=shared`, `FOGD_TLS=1`, `FOGD_PUBLIC_BIND_ADDRESS=0.0.0.0`, and the TLS Secret must contain a `keypair.json` key with `{cert,key}` JSON mounted at `/var/lib/fogd-tls`, since that is what `loadTLS` reads. Do not leave `FOGD_PUBLIC_BIND_ADDRESS` at the Compose default of `127.0.0.1`, which would pass the check dishonestly. Bootstrap order is therefore: certificate, Secret, admin credentials, then scoped tokens over port-forwarded HTTPS. The renderer can reuse `validateKeypair` directly rather than the Docker helper-container path in `tls.mjs`.

4. **Node identity must be bound to the ordinal, not to a free-form env value.** ADR 005 requires identity, advertised address, and disk to move together and forbids two live processes with one identity. StatefulSet ordinals give that binding for free: set `CELLD_NODE` from the downward API pod name and `--advertise $(POD_NAME).slot-1.$(NAMESPACE).svc.cluster.local:8081` using container arg expansion. Identities become `slot-1-0`/`slot-1-1` instead of `slot-1-a`/`slot-1-b`. That is an infrastructure-only configuration change and must be recorded as such, since it means a Compose volume and a PVC are never interchangeable.

5. **Per-fleet network isolation regresses.** Compose gives each fleet a private network (`fleet-1`, `fleet-2`, `control`). kind's default kindnet does not enforce NetworkPolicy, and celld runs with `--trust-forwarded-headers`, so any pod in the cluster can reach `slot-1-0:8080` with forged forwarding headers and hit paths the gateway blocks (`gateway.js:22-24`). The spec already refuses to claim isolation. It must additionally record this as a known regression versus Compose and as a trust-boundary item for the remote M9 gate, where a policy-enforcing CNI exists.

## Issues that shape the manifests

- **Probes.** The supervisor sleeps 15 seconds before starting celld on every start (`celld-supervisor.sh:9-13`) and restarts celld internally on exit, so a dying celld never shows CrashLoopBackOff. Use a startupProbe with headroom for the lease delay. Do not add a livenessProbe to celld in this slice: a liveness kill during a long recovery read restarts the pod, adds another lease wait, and can loop. Readiness on celld is for rollout ordering only because the gateway preflights each replica itself.
- **Graceful shutdown.** Compose uses 45 seconds for celld. The controller exits 30 seconds after SIGTERM (`main.mjs:21`). Set `terminationGracePeriodSeconds` to 45 for celld and at least 35 for the controller.
- **Pod spreading.** Acceptance step 4 is meaningless unless the two replicas of a slot sit on different workers. Create kind with two workers and add required podAntiAffinity on the slot label with `kubernetes.io/hostname`.
- **bucket-init.** Becomes a Job. `ensureBucket` already retries for 60 seconds, so no init-container choreography is needed. celld pods will fail and restart inside the supervisor until the bucket exists, which is acceptable but should be noted.
- **Images.** `kind load docker-image` preserves the image config ID but there is no registry digest, so `image@sha256:` references are impossible. Use the tag with `imagePullPolicy: Never`, then have the runner compare each pod's reported imageID against the local `docker image inspect` ID and write both into the evidence file. That is the honest "immutable identity" for this topology.
- **Storage reality on kind.** The default StorageClass is local-path with `WaitForFirstConsumer` and reclaimPolicy Delete. Deleting workloads keeps PVCs. Deleting the namespace or the PVCs deletes data. `kind delete cluster` deletes everything. The teardown doc must say "delete workloads only" and name both destructive commands.
- **Node stop will not reschedule anything, and that is correct.** When a worker is stopped, its pod goes Unknown, then Terminating after the taint eviction timeout, and the StatefulSet will not create a replacement until the old pod object is gone. The local PV also has node affinity to that worker. The observed result will be "fleet runs on one replica until the node returns." The runbook must forbid `kubectl delete pod --force --grace-period=0` on such a pod because it violates ADR 005's one-live-process rule.
- **Resources.** Map Compose limits one to one: celld 512Mi and 1 CPU with 128MB V8 heap, MinIO 768Mi and 2 CPUs, controller 512Mi, gateway 256Mi.

## Recovery sequencing

M8 backup is Docker all the way down: `docker ps` filters, `docker run --mount type=volume`, `docker image save` (`backup.mjs`, `docker.mjs`). Only the bundle format, checksums, and `verifyBundle` transfer. The Kubernetes adapter is distinct, so split to M9b as the spec allows. The sequence for M9b, mirroring the Docker order:

1. Scale gateway and controller to 0, then both slot StatefulSets, then MinIO. Wait for pods to be deleted, not just Terminating. A Terminating pod on a dead node still holds the PVC.
2. For each PVC, run a helper pod that mounts it read-only and stream `tar -cpf -` through `kubectl exec` into a local file. This is the same shape as the current `docker run ... tar` call.
3. Record image IDs from the manifests and save the image tarball from the local Docker daemon. State in the manifest that this works only because images were loaded from this checkout. A remote cluster needs a registry-backed digest.
4. Restore into a fresh namespace: create PVCs, untar via helper pods, verify with `tar --compare`, then apply manifests with pinned IDs. Refuse an existing namespace.

For M9a now, the cheapest honest step is a refusal: have the renderer write `FOGD_TOPOLOGY=kubernetes` into the installation file and make `backup()` throw before any Docker call when it sees it. `validateTopology` already rejects a non-Compose shape, but the error message would be misleading.

## Scope: cut to this first slice

The spec bundles render, cluster runner, two apps, replica replacement, node stop, teardown, and recovery doc. Ship this instead:

1. **Renderer.** One new file under the CLI that reads the installation file through `configEnv`, validates with the same slot rules as `main.mjs`, and writes `manifests.yaml` plus a separate `secrets.yaml` at mode 0600 under `.fogd/k8s/<name>/`. That path is already gitignored. Reuse `validateKeypair` for the TLS Secret. No Helm.
2. **Runner.** One script that creates `kind-fogd-<name>` with two workers and `--kubeconfig .fogd/k8s/<name>/kubeconfig`, checks `current-context` and node names match before any apply, loads the two images, applies, port-forwards admin and app ports, and reuses `platformClient` with `FOGD_SERVER` and `FOGD_URL` pointed at the forwards. Never touch the KUBECONFIG environment variable or the default config.
3. **Acceptance 1 through 3 only.** Two apps are nearly free because `installation-recovery.mjs` already drives accounts plus notebook. Replica replacement is `kubectl delete pod slot-1-0` without force, then assert the same PVC rebinds and data reads back.
4. **Acceptance 4 as observation only.** Stop one worker, record what happens, do not gate on it.
5. **Teardown doc** with the delete-workloads-only rule. Recovery procedure and M9b refusal message as the only recovery deliverable.

Mark M9a experimental in the roadmap until M9b and the remote-host gate pass.