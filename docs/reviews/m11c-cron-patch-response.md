# Cron retry patch review response

Four Claude reviews refined the pinned celld cron patch. The [review records](m11c-cron-patch-claude.md) capture each candidate and finding.

The patch persists each armed occurrence, its expression identities and alarm deadline atomically with the alarm update. A reconstructed cron object retains that record. A retry uses original scheduled time, and expression reordering cannot redirect it to a sibling. A missing legacy identity is logged and skipped rather than guessed. The native next-occurrence policy remains; missed ticks do not become a backlog. Interrupted groups can repeat successful side effects, so apps need idempotency.

The patch uses celld's native active-alarm state to guard cold arming. A later review found that hard timeouts, wall-clock expiry and stuck handlers do not consume celld's counted retry ceiling. The patch advances after six native retry attempts for one armed alarm. Each application retry resets the native counter, so this is not a six-attempt total bound. A timeout can skip its occurrence and prevent later siblings from running. The cap constant mirrors celld's `RETRY_CEILING` and must track upstream changes.

The patch passed a disposable two-node owner-loss test. The failed expression retried with its original scheduled time; the successful sibling did not rerun. The build compiled the lab binary, but Debian signature verification blocked the upstream test/clippy stage. Native timeout and transaction-interruption behavior remain unqualified.

The patch is not safe for rolling or mixed-version replacement. celld dispatches as soon as any node starts, and a stock owner can leave a stale patched record behind. Stop all nodes, replace every runtime, then start the fleet together. This causes full downtime and is a manual precondition; fogd's planned pause control is not implemented. Cron admission remains closed until durable approval, pause, recovery and timeout behavior are qualified.
