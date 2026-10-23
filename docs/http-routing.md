# HTTP routing controls

`fogd admin routing` inspects and controls an application's durable HTTP authority.
The command is implemented in source for the candidate durable-routing controller;
no shipped runtime family currently qualifies this interface. The cached legacy
controller returns an unsupported-feature error. Native acceptance remains open.

Configure `FOGD_SERVER` and owner credentials as described in the
[operator guide](operator-guide.md). Routing uses administrator authentication;
a deploy token cannot authorize these decisions.

```sh
fogd admin routing APP
fogd admin routing APP status
fogd admin routing APP pause DEPLOYMENT_ID SHA256
fogd admin routing APP resume DEPLOYMENT_ID SHA256
```

Status reads the public authority through the controller and reports its revision,
active approval, held approval, pending publication and startup-blocked flag.
Output contains selected fields only; private response errors and unknown fields
are withheld. An active record describes routing authority. It does not establish
application health or permission to start a gateway when startup is blocked.

Use [`fogd admin inspect APP`](application-inspection.md) to identify the recorded
active release, including when an HTTP pause leaves no active or held reference
in routing status. Review that release before selecting a decision.

Pause requires the current completed deployment and its exact artifact digest.
Resume requires the selected approval and controller verification of its runtime.
The CLI never chooses the newest deployment or substitutes a different approval.
A successful response reports the checked authority state. HTTP pause is separate
from queue delivery and scheduled dispatch controls; use their dedicated commands
for background work. HTTP pause is also separate from the stopped backup procedure.
Existing requests and sessions are not drained by changing route authority.

## Resolve an interrupted publication

Inspect status before choosing between completing a pending active publication
and withholding it:

```sh
fogd admin routing APP reconcile DEPLOYMENT_ID SHA256 ACTIVE_INTENT
fogd admin routing APP withhold-pending DEPLOYMENT_ID SHA256 ACTIVE_INTENT
```

Use the exact intent printed in `pending.intent`, together with that publication's
approval. A pending publication can belong to another app; use its `pending.app`
as the command target. Reconcile verifies the approved runtime before completing publication.
Withhold-pending withdraws that publication without verifying or changing the
application backend. Both decisions are available through the restricted routing
recovery service. Resume remains unavailable there. Keep ingress stopped until
[pre-ingress checks](serving-authority.md#pre-ingress-observation-candidate) and the
ordered installation startup procedure pass; a routing acknowledgment alone does
not authorize starting the gateway.

Each decision fetches a fresh mutation token, sends one authenticated POST and
checks the reply against the selected application and requested outcome. It does
not retry automatically. A lost, malformed, oversized or inconsistent reply leaves
the outcome uncertain, even if the controller changed authority. Inspect status
again before deciding the next action; do not assume an uncertain pause succeeded.
Redirects are refused without forwarding owner credentials.

Process tests exercise the CLI against local HTTP servers, including the real
controller with temporary authority/private files and a substituted backend. They
cover pause/resume and both pending-publication decisions. Native runtime, gateway
and mount qualification still follow the [serving contract](serving-authority.md).
