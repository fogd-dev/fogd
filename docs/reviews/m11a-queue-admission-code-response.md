# Queue admission implementation review response

Claude reviewed the implementation twice. The first review found two blockers:
disabling admission blocked previously approved retries, and app-name reuse could
strand unapproved queue history. Both are fixed. The follow-up found no remaining
correctness blockers and independently ran 148 relevant tests successfully.

Admission now distinguishes a new request from an exact retry carrying its prior
secret-revision pin. An unapproved request remains artifact-only after rejection or
supersession if no app references its ID. Canonical queue equality and strict UUID
checks protect that classification. Kubernetes rendering has an explicit regression
that user settings cannot enable the opt-in.

A rejected, verified released claim also remains inert after an unrelated approval
reuses its name. This extends the first review's conservative app-absence suggestion:
requiring perpetual absence would recreate the backup problem. The release is a
historical fact established before terminal rejection, and references to that old
approval still cause refusal. Claude's follow-up reviewed and accepted this reasoning.

The full suite passes at 261 tests, along with builds and quality checks. The initial
normal CLI Docker probe verifies scoped upload, pending-only snapshot/restore, exact
approval, derived Void dispatch, failure and explicit retry. A separate real bucket
outage verifies failed-claim rejection and successful backup.

The follow-up review still listed Docker coverage of its fixes as pending. The
subsequent current-image history drill now passes both: SIGKILL a controller during
an approved update, restart with admission disabled, retry the pinned approval, and
back up after a non-queue approval supersedes an inert queue request under the same
name. Previously rejected and released requests remain retained and do not disable
backup. Docker inspection independently confirms the controller used FOGD_QUEUE_APPS=0.

Default admission remains off. Additive update/overlap, pending queued recovery,
retirement of canonical artifacts, duplicate deliveries, and browser acceptance
remain next. Neither the review nor these checkpoints claim the full M11a contract.
