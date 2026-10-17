# M10b design review response

Claude's [review](m10b-design-claude.md) selects an offline snapshot transformation
into a fresh Docker installation. Accept that direction. The original proposal's
online preparation, in-place journal, resumption, and in-place volume allocation
are superseded by these amendments.

The command is `fogd retire BUNDLE --app NAME --digest SHA --project NEW --output DIR`.
It verifies the complete stopped bundle, pins an existing active deployment, and
refuses absent, quarantined, uncertain, never-activated, or already-retired apps.
The source project must remain stopped, including any foreign consumer of its named
volumes. Source storage and the backup are never mutated. Failures retain a stopped
partial target and refuse reuse; retry uses another new project. No resume promise.

Every target volume is fresh. Restore the unaffected fleet, bucket, controller, and
optional TLS state. Verify but do not extract the retired fleet's two replica tars.
Rewrite only its bucket prefix and replica identities, plus the matching slot
configuration in controller/gateway. Retain old prefix data, old source volumes,
secret revisions, artifacts, and approval history. No deletion or secure-erasure
claim belongs here.

Use a UUID generation prefix disjoint from configured and previously retired
prefixes, rather than a child of the old prefix. This avoids overlapping namespace
scans and generation counters. Record old and new identities in private retirement
evidence. The drill must prove the new prefix has no inherited D1/R2/DO state.

The controller transform retains an app-name tombstone with no assigned slot and
marks pending/failed proposals retired. Guards reject submissions, all approval or
rejection mutations, credential issuance, and secret replacement for that name.
Place the mutation guard before the reject branch: the existing reject path does
not call available(). Retired routing returns unknown/404. Startup refuses configured
prefixes overlapping retired prefixes and skips tombstones during ordinary ownership
reconciliation. Existing ownership conflicts continue to consume capacity.

The snapshot's pinned runtime image must demonstrate retirement support before
creating target resources. Older images cannot be assumed to honor tombstones;
operators must upgrade and take a new snapshot first. Keep the controller transform
in one platform module, reused by the CLI through a workspace dependency.

Write generated configuration as compose.pending.json until restoration,
comparison, transformation, and validation succeed. Publish compose.json and the
completion receipt only at the end; documented startup requires both. No automatic
startup occurs. This is an exclusive operator procedure, not protection against an
administrator deliberately starting partial containers with raw Docker commands.
Apply the same pending-file convention to ordinary restore and warn that restoring
older backups can resurrect apps and credentials.

Multi-app deploy tokens remain usable for their other scopes. Retired-name checks
block old authority from creating a differently named replacement. Administrators
may revoke obsolete tokens separately. Hosted migration, Kubernetes retirement,
background-job draining, same-name reuse, and storage credential isolation remain
outside the first qualification. Preserve the original acceptance goals using safe
refusal rather than journal resumption for interruptions.

## Implementation review amendments

Claude's [code review](m10b-code-claude.md) found no isolation or correctness blocker.
Accept its refusal-set correction: a paused app may retire when it still has a known
active deployment, no quarantine, no uncertain migration, and no activating request.
This permits retiring a broken but reconciled redeployment without first making it
serve again. Never-activated and ambiguous apps still fail closed.

Mark the former active deployment retired as well as pending and failed proposals;
the tombstone retains its digest and deployment ID, and history remains available.
Update the capacity page to point to the stopped workflow. Added checks cover
historical prefix overlap, malformed tombstones, real HTTP approval/secrets refusal,
and corruption in a replica archive that retirement would otherwise skip extracting.

## Final qualification

Claude's [final review](m10b-final-claude.md) found no blocker. Clarified that fault
injection pauses after the controller archive copy, and that old-image refusal can
leave loaded images and a private output directory without creating target containers.
The 70-test count covers the entire workspace, not just the platform package.

The fresh fogd-m10b4 drill passed with a certificate covering all fixture names.
It preserved native accounts sessions/login, retained old prefix objects, proved an
empty replacement prefix before startup, and then verified empty and newly written
D1/R2/DO state under the replacement name. The negative drill passed interruption
without a final config/receipt, occupied-target retry refusal, fresh-target retry,
old-runtime refusal before container creation, and ordinary full-volume restoration.
That ordinary restore recovered notebook's old data, demonstrating the documented
resurrection boundary, before the test returned to the retired installation.
