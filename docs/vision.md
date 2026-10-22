# Vision and product goals

**North star: Cloudflare you can control and touch.**

fogd is an application cloud you can own, run, inspect, and change on infrastructure
you control. Your homelab and team infrastructure are places to run that cloud and
host useful applications. The integrated developer experience, operational controls,
and freedom to move code and data serve this product goal.

This vision anchors planning. The goals and sequence below are proposals, not a
claim that fogd v0 implements them. Current evidence lives in [features.md](features.md)
and [report.md](report.md); [roadmap.md](roadmap.md) connects goals to milestones.

## What the experience should feel like

A developer creates a complete application, runs it locally, and declares the data
and capabilities it needs. They deploy to a fogd installation, receive a usable URL,
and keep updating the app without separately managing its runtime and storage.
Operators decide who can deploy, what capacity applications receive, and how the
installation is maintained and recovered. An individual can fill both roles.

The app should remain useful after the developer closes their laptop. Its data
should survive the documented failures and be recoverable after loss. Moving to
another installation or a supported managed target should have an explicit,
tested path for code and data. Each target retains its own operational properties.

## What each layer contributes

| Layer | Contribution to the vision | Boundary |
| --- | --- | --- |
| Void SDK | Full-stack composition: server routes, rendered pages, typed resource APIs, and types carried into the UI | Qualify source-inferred bindings, typed clients, environment schemas, and asset manifests as well as the backend |
| Void CLI and Platform experience | Integrated builds, resource provisioning, migrations, deployments, and administration | fogd provides the owned-infrastructure path; existing Cloudflare provisioning is not reused |
| Workers application contract | A recognizable runtime and resource model, including Durable Objects, with compatibility targets | Compatibility needs method, lifecycle, and failure evidence, not just accepted configuration |
| celld and workerd | Runtime capabilities and self-hosted execution building blocks | Their combined feature inventories do not establish fogd support |
| fogd | Installation, resource lifecycle, deploy policy, routing, diagnosis, recovery, and a coherent developer/operator workflow | fogd integrates upstream capabilities rather than reimplementing every service |

Void's features are optional and composable. Preserve the SDK experience without
requiring every application to use every abstraction. Void is the first supported
development path; accepting other Workers projects is a later compatibility goal.
fogd currently replaces the deployment backend with its own approval controller;
it does not host Void Platform unchanged. Preserving the integrated experience
does not imply matching Void Platform's roles, usage reporting, or every SDK feature.
Source: [Void README at the audited revision](https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/README.md).

## Product promises and evidence

| ID | Proposed promise | Evidence that would support it |
| --- | --- | --- |
| G1 | Build a complete app through an integrated developer experience | A supported Void template carries a typed UI/API/data change through local development, build, deployment, and update; needed assets and app authentication work |
| G2 | Operate the application on infrastructure you control | A documented installation supplies resources and stable routing; a second person follows installation/upgrade/recovery procedures without undocumented author intervention |
| G3 | Keep control as applications and collaborators grow | Distinct submit/approve rights, declared resource changes, scoped credentials, useful diagnosis, and enforced capacity policy pass scenario tests |
| G4 | Retain freedom to move code and data | A supported app builds for the declared targets, exports and restores its state, and receives explicit compatibility findings; hosted behavior stays unverified without hosted tests |
| G5 | Expand capabilities without making the default installation depend on them | An optional integration has its own contract and evidence; baseline installation and existing app behavior remain testable independently |

Track developer and operator effort separately: initial setup, per-app manual work,
updates, failure diagnosis, and recovery. Record assistance and failures rather than
inventing a speed or cost advantage. Compatibility evidence and recovery drills
matter alongside convenience. A shorter deploy command alone does not satisfy G1–G4.

## Use cases that can test the vision

FilOz's team demo-hosting need is a candidate first pilot: colleagues already build
apps and want an easy persistent destination on their infrastructure. It can test
G1–G3. A homelab can test installation and recovery with limited resources; an
independent product can test the option to move to managed hosting; a learning
environment can expose the runtime and state model. These uses inform priorities
without narrowing fogd to demos, one organization, or one deployment topology.

Future Filecoin storage is an optional possibility under G5. Upstream storage,
encryption, and access-control work is still evolving. Keep it in the opportunity
list without designing an integration or making it a near-term dependency.

## Boundaries and tradeoffs

"Your own application cloud" is the ambition. Matching Cloudflare's global network,
attack-absorption capacity, every service, or managed operations is outside the
software promise. Compatibility should grow through explicit profiles. Operators
still provide capacity and maintain the system; self-hosting is not cost-free.

Coolify is a valid alternative for container applications and database deployment.
fogd's proposed distinction is integrating Void's application experience with
declarative resources and a tested portability contract. If it only wraps container
launches, that distinction has not been demonstrated.
Sources: [Coolify applications](https://coolify.io/docs/applications/),
[databases](https://coolify.io/docs/databases/).

Public hosting of arbitrary untrusted code, a general container orchestrator, and
automatic multi-region operation are separate investments. Retain trusted,
reviewed code as the initial hosting boundary. No Cloudflare credentials/API calls,
npm publication, or changes to private infrastructure are part of this planning work.

## How to keep the roadmap intentional

Every proposed milestone names the promise it advances, a product scenario, an
acceptance condition, and work it deliberately excludes. Prioritize gaps that
block complete apps or safe operation before adding unused binding names. Keep
platform capability separate from the pilot used to test it.

Before admitting an idea to an implementation milestone, answer four questions:

1. Which goal and scenario does it advance, and what fails without it?
2. What work does a developer or operator stop doing, and who maintains the change?
3. Which acceptance test or recovery drill demonstrates the promise and its limits?
4. Does it preserve the baseline installation and declared portability contract,
   including operation with optional integrations disabled?

An idea stays in exploration until these answers exist. Record setup/update steps,
author interventions, recovery time/loss boundaries, and test-backed compatibility
findings before setting improvement targets. Revisit the sequence when a pilot
disproves an assumption. Change the vision explicitly if needed; do not change it
accidentally by accumulating pilot requirements.
