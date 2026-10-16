# Claude product-direction follow-up

# fogd product-direction follow-up (Claude)

Everything here is a recommendation. Technical claims come from the two prior reviews and the triage notes, not a fresh scan.

## 1. Product positions, ranked

1. **Portable app incubator with a managed Cloudflare exit.** Build Void apps against Cloudflare-shaped bindings on hardware you own, and keep the option to move to Cloudflare when an app earns it. Value over plain Docker or Kubernetes: the app code and data model are already in Cloudflare's vocabulary, so the exit is a build target change plus a data export, not a rewrite. Value over starting on managed Cloudflare: zero marginal cost per experiment, no per-account limits, no vendor lock before revenue. This is the only position where the approval gate, immutable artifacts, and replicated state all earn their keep, because they are what makes the homelab trustworthy enough to leave an app on it.
2. **Learning environment for Cloudflare systems.** Real value, but it argues against most of fogd. A single celld replica with direct deploy teaches D1, R2, and Durable Objects as well as the fleet does. The controller, slots, and approval teach you fogd, not Cloudflare. Rank it second only because it is a free byproduct of position 1, not because it justifies the platform.
3. **Team app platform on Kubernetes for FilOz.** Plausible, but unvalidated and currently unfunded by any named need. Against plain Kubernetes it offers only the Cloudflare binding shape and the approval ceremony. A team that already runs Kubernetes gets review gates from Git and durable state from Postgres. Do not pursue this until a FilOz teammate names an app they would build this way.
4. **Self-hosted Cloudflare replacement.** Lowest rank. Two hosts cannot deliver the operational tier that makes Cloudflare worth paying for, and both prior reviews documented that honestly.

**What does not justify maintaining fogd:** "I can run Cloudflare-style apps at home" on its own. Docker plus celld standalone already does that. fogd is justified only if the lifecycle layer, meaning approval, immutable releases, recovery, and eventual exit, is something you will actually exercise.

## 2. App hypotheses

Treat all of these as guesses to be confirmed with the people involved.

- **FilOz: deal or retrieval status board.** Polls public Filecoin endpoints on a schedule, stores snapshots in D1, serves a dashboard. Exercises cron, which fogd rejects today, so it is a good probe of the background-event gap.
- **FilOz: shared link and snippet shortener with audit log.** D1 plus R2, trivial schema, low stakes. Useful for testing team deploy flow without anyone depending on it.
- **Homelab: personal bookmarks and reading queue** with full-text search. D1, R2 for article snapshots, one DO for a live "currently reading" view. Covers every binding fogd supports today.
- **Homelab: household inventory or home-maintenance log** with photo attachments. R2 heavy. Would surface the multipart upload split across replicas that both reviews flagged.
- **Small business: a paid waitlist or form-capture product.** One DO per form for rate limiting, D1 for submissions, R2 for uploads. This is the kind of thing that could plausibly earn money and want to move to Cloudflare later.
- **Small business: a changelog or status page service** for other small projects. Mostly static assets, D1, scheduled checks.

**Best single pilot: the personal bookmarks and reading queue.** It touches every supported binding, has real daily use so you will notice breakage, and nobody else depends on it. If it dies, you lose convenience, not trust. It also doubles as the learning app.

## 3. Smallest discovery milestone

**Outcome:** one pilot app runs on fogd under Docker for a sustained period, and an offline export of that app exists that a future Cloudflare deploy could consume. No new bindings, no homelab.

Separate three kinds of portability:

- **Code portability.** The Void app builds for both targets from one source tree. Verifiable offline: a `wrangler`-shaped build output alongside the fogd artifact, no Cloudflare calls.
- **Data portability.** D1 as SQL dump, R2 as object listing plus bytes, DO state acknowledged as the hard case. Verifiable offline as an export script whose output you can inspect. Import into hosted Cloudflare cannot be verified here and should be stated as unverified.
- **Operational portability.** Recovery, rollback, TLS, uptime. This does not transfer at all. Cloudflare provides it, you provide it on fogd. Say so plainly and do not count it toward "compatibility."

Exit criteria: the pilot app has survived one controller restart and one replica restart with data intact, the export script produces a code bundle and data bundle, and you have written one paragraph on whether you still want this platform. That paragraph is the real deliverable.

## 4. Kubernetes and homelab

Neither needs an operator or a scheduler. fogd's unit is "two celld containers plus a bucket plus a controller." On Kubernetes that is a StatefulSet with two stable pod identities and persistent volumes, a Deployment for the controller, and an S3-compatible bucket you already run or MinIO. Compose and that manifest can coexist indefinitely. The homelab is the same shape across two Docker hosts.

Decisions that can wait: Kubernetes at all, two-host networking, TLS source, per-slot bucket credentials, slot count, approver identity separate from submitter, and whether the HTTP pause needs a replica-side quiesce. The last one matters only once a real app uses alarms or background work. Document it as a known limitation now, design it when the pilot needs it.

## 5. What to defer from my first recommendation

- **Homelab deployment and the two-host Compose variant.** My first review made it part of the next milestone. Without a real app, it moves fragility to two machines.
- **Backup and restore scripts as a milestone gate.** Still necessary before anything you care about lives here, but the pilot app is explicitly something you can lose. Write the restore drill when the pilot survives long enough to matter.
- **Rollback to a previous digest.** Still the cheapest controller change, but it is lifecycle polish for a product you have not chosen yet.
- **"At most one new binding."** Zero new bindings. The pilot should fit the current allowlist.

What survives from the first review: pick a real app, validate whether approver and submitter are the same person, and treat the pause and alarms gap as a documented limitation, not a bug to fix speculatively.

**Remaining uncertainty:** whether the Void build can emit a Cloudflare-targeted bundle without Cloudflare tooling calls at build time. That is a question for the pinned Void sources, not something I verified here.
