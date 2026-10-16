# M9a: Kubernetes deployment contract

## Scope and purpose

Make the same approved Void app deployable on an operator-owned Kubernetes cluster
without exposing cluster credentials to app authors. First qualify manifests on an
isolated local kind cluster; retain actual remote host/storage/network failure as
an explicit M9 gate. Local kind nodes share a Docker host and cannot prove physical
host resilience. Do not access the user's existing Kubernetes contexts or FilOz
cluster. Keep kubeconfig and generated secrets inside ignored private repo paths.

## Proposed deployment

Generate ordinary Kubernetes resources from a private installation file, with no
operator/controller framework. Use a dedicated namespace, one controller, one
gateway, a bucket initializer, and two two-replica celld fleets. Use stable DNS and
replica identities with StatefulSets and individual PVCs. The controller also needs
a PVC. MinIO with a PVC is the local qualification bucket; external bucket support
requires a separate recovery contract. TLS key material enters a Kubernetes Secret
mounted read-only; explain that default Secrets are not encrypted at rest by fogd.

Keep native public TLS and private controller routing. Publish only app/admin TLS
ports through operator-chosen Services; local qualification uses port-forwarding or
kind port mappings, never a public load balancer. Runtime and bucket ports are
ClusterIP-only. Workloads remain trusted. Specify requests/limits, graceful shutdown,
readiness, and stable advertised replica addresses. Do not infer network isolation
from ClusterIP or ship an unenforced NetworkPolicy claim.

Use the pinned runtime images already built by the checkout, load them into kind,
and record immutable image IDs/digests in generated deployment evidence. Avoid
registry publication. A manifest renderer is a local reversible operation; applying
to an existing cluster is outside this drill. The explicit test runner creates its
own named kind cluster with a repo-local kubeconfig and checks that identity before
any mutation. No global tools or kubeconfig modifications.

## Acceptance and ordering

1. Review generated manifests and validate required names/settings before output.
   Secrets are private files, omitted from logs, git, and app artifacts.
2. Create an isolated kind cluster and deploy two supported apps through HTTPS,
   scoped submission, and admin approval. App authors use the existing fogd CLI.
3. Exercise D1/R2/DO writes and native account sessions across gateway/controller
   restarts and individual replica pod replacement. Preserve identities and disks.
4. Stop one kind worker node and record observed availability and recovery limits.
   Do not count node restart as durable recovery or pretend local PVCs move hosts.
5. Document teardown that retains durable state by default and a stopped recovery
   procedure for this topology before declaring the deployment suitable for valuable
   data. A renderer plus successful startup alone cannot satisfy M9.

Split recovery into M9b if its storage mechanics require a distinct adapter, with
M9a clearly marked experimental until that gate passes. M8's Docker backup command
must refuse Kubernetes topology rather than pretend to cover PVCs. Keep the
application contract identical and record any infrastructure-only configuration
changes. The full M9 milestone still needs actual second-host evidence; unavailable
hardware is a documented boundary, not a reason to fabricate it or stop other work.

## Choices for review

Ordinary manifests are easier to inspect and transfer than a bespoke operator.
Helm could provide packaging later; first establish the resource contract. Local
kind is available and isolated, while access to an authorized remote cluster has
not been established. Its limitations must remain visible in reports. Review
StatefulSet ownership, supervisor assumptions, storage and recovery, DNS, bootstrap,
credential handling, and whether the scope should be reduced before implementation.
