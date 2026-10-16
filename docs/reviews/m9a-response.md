# M9a review response

Claude's [design review](m9a-design-claude.md) identified DNS readiness, singleton
controller ownership, identity/disk binding, and weaker default cluster networking
as constraints. The manifests use headless fleet Services with
publishNotReadyAddresses, ordinal-derived identities, required per-fleet node
separation, and retained PVCs. Controller and MinIO use single-replica StatefulSets
with OnDelete updates, preventing an automatic overlapping Deployment rollout.
Operators must not force-delete pods whose old process might still be running.

All generated platform settings require shared TLS. Kubernetes Secrets carry the
keypair JSON expected by the existing runtime. Private settings stay in separate
mode-0600 output files. Local images use Never pull policy, with pod image identity
verification in the drill; remote image references require digests.

Accepted the recovery split: M9a is experimental deployment/pod-replacement evidence;
M9b must qualify stopped PVC recovery. The renderer creates an installation file
marked kubernetes, and Docker backup refuses it before Docker operations. Actual
remote host/storage/network tests remain a separate full-M9 gate. Stopping a kind
worker is an observation, not proof of physical resilience.

Bucket readiness uses the existing retrying initializer as init containers for
controller and fleets. This differs from the proposed Job but explicitly blocks
stateful startup until bucket initialization succeeds. It requires no new readiness
implementation. No celld liveness probe can interrupt recovery; startup/TCP readiness
have headroom for the supervisor lease delay. Every pod disables service-account
credential mounting. Default kind networking still permits lateral traffic, a known
regression from the Compose fleet networks; a policy-enforcing CNI and qualified
rules are required for the remote shared-operation gate.

The StatefulSet and kind contracts were checked against the official
[StatefulSet documentation](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
and [kind configuration documentation](https://kind.sigs.k8s.io/docs/user/configuration/).


## Code review amendments

The [implementation review](m9a-code-claude.md) caught namespace deletion through the
ordinary manifest's inverse command. Namespace creation now has its own file; normal
workload/Service deletion retains PVCs. Secrets apply before workloads, and the drill
waits on StatefulSet rollout rather than a potentially empty pod selector.

The renderer now passes controller admission and runtime resource limits through,
converts Docker memory units, refuses an external bucket, and omits Compose replica
identity/hostname overrides from the generated environment. Kubernetes owns those
identities. Documentation records root containers, Secret storage, manual updates,
force-deletion hazards, and the unstable kind-import image display labels.

Each replica now has its own stable ClusterIP Service for gateway/controller/peer
traffic. This avoids relying on workerd re-resolving a changed pod IP. After replacing
ordinal zero, the drill temporarily removes ordinal one and verifies account/session
and notebook access before restarting the gateway, so failover cannot hide a stale
backend. Headless Services still govern StatefulSet pod identity.

The initial evidence came from manual setup. The committed setup runner then passed
from scratch on m9verify; a fresh m9final2 run exercises the review amendments after the disk-capacity retry. Only
completed runs count as evidence. Kubernetes recovery remains a separate gate.


The [final review](m9a-final-claude.md) caught kubectl rollout status rejecting
OnDelete StatefulSets. The amended runner hit that exact error before deploying
apps. Its waits now use the StatefulSet readyReplicas JSONPath condition, including
after scaling back to two replicas. Retried against the still-empty final fixture.
Generated environment settings now use an explicit supported-key selection, omitting
host-publishing/local-profile settings; topology.json records infrastructure changes.
