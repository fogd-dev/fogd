# Observe serving during deployments and controller interruption

Use the repeatable local probe to measure an app while another app uploads and
activates a release. It compares gateway requests with direct reads from one
replica and records the effect of stopping the controller. This is part of the
[operator-readiness measurement work](operator-readiness.md), not a capacity limit
or production availability qualification.

```sh
node scripts/cron-probe/selected/serving.mjs .fogd/serving-observation-01
```

Use a new private output directory. The probe requires the cached qualified Linux
arm64 two-fleet runtime, classic overlay2 Docker, and the prepared guestbook builder
dependencies. It installs no dependencies and builds no runtime image. It creates
its own local installation with private credentials and a dedicated observer, then
removes only its own containers and networks. All volumes and failed evidence are
retained. It does not stop an existing installation.

## Workload and raw records

Two copied guestbook apps contain different seeded messages. Each request reads
`/api/messages`; its complete response must match the expected baseline body's
hash. An HTTP 200 with a different body is an error. The original example sources
remain unchanged.

A dedicated observer container has one CPU and 128 MiB of memory. Two workers per
path wait 100 milliseconds after each completed request. Gateway traffic uses TLS;
direct traffic uses HTTP to one replica. TLS verification remains enabled. The
connections use keep-alive after their initial handshakes. The request deadline is five seconds and the response bound is 1 MiB. Latency includes
body consumption and failed requests. Raw samples retain monotonic start/end times,
path, HTTP status (zero for a transport failure), and body correctness; response
bodies, credentials and headers are omitted.

The phases are idle reads, two simultaneous maximum-size peer uploads, exact peer
approval, controller stop/start, and recovered reads. Upload payloads are prepared
before observation. The upload phase checks admission and retained-byte accounting;
activation checks the exact approved artifact. Padding is split into files no
larger than 16 MiB so the total-size workload respects the native per-file asset
limit; it does not reduce the total admitted artifact size. The baseline approval must remain
unchanged after every phase. Minimum phase windows are 10, 20, 45, 30 and 10
seconds respectively. Sampling continues through a longer action and five seconds
after its end, with a five-minute cap on scheduling new requests. Pending requests
can take up to their deadline to finish; an incomplete action or tail fails the run. The deliberate controller outage does not stop either
application's replicas.

Interference markers are recorded through a loopback-only endpoint in the observer
using the same monotonic clock as the requests. They bracket the host action and
include marker-command overhead. The report checks that both markers fall within
the observation window and that requests overlap it on both paths. Overall phase
summaries include all samples; overlap summaries include requests crossing either
boundary. The measured interval is not assumed to equal a configured sleep.

`observer-PHASE.json` retains the observer's exit status, signal and raw output.
`result.json` retains the samples, distributions, status counts, action outcomes,
cgroup counters, source inventory and shutdown evidence. Its separate post-write
privacy record authenticates the saved receipt. A failed process or partial output
is not an accepted measurement. Failed trials retain available service logs in
`runtime-failure.log` before cleanup; failure to collect them is recorded without
replacing the original failure. Logs stay private and existing log files are not
overwritten. A failed log-collection command may retain its own private command
diagnostic; the original failure still identifies its original diagnostic.

## Interpret the comparison

The paths differ in TLS, routing lookup, health checks and replica selection. This
comparison does not isolate the CPU cost of ingress or identify which component
caused an individual delay. Both paths share the observer, Docker VM, host, storage
and background workloads. Observer CPU/memory counters and engine resources are
recorded so those limits remain visible. This paced closed-loop workload reduces
its offered rate when responses slow; it does not measure saturation.

Controller memory and CPU counters are collected after each phase. These cgroup
counters include deployment subprocesses during activation. Peak memory is
cumulative within that controller start, rather than a phase-specific peak or RSS.
The recorded start time identifies the reset after the deliberate restart. Observer
counters are also cumulative for its container. Compare counter deltas only within
the same start interval.

Gateway errors during controller interruption are expected evidence of the default
legacy family's routing dependency. Direct reads must continue and recovered gateway reads must
succeed. Upload/activation errors remain in the report; they are not filtered out
or converted into a passing availability claim. No routing cache or approval/pause
semantics change is part of this probe.

Repeat runs and inspect all raw errors before choosing an operating limit or
architecture change. Other app counts, concurrent writers, different hardware,
remote networks and production traffic require their own measurements.

## Observed local behavior

The [local evidence receipt](evidence/operator-serving-local.json) records two
completed runs on a shared Linux arm64 Docker VM: 10 vCPUs, approximately 15.6 GiB
of VM memory, classic overlay2, and 46 unrelated running containers. Each
controller had one CPU and 512 MiB. The table shows the range of each run's
whole-phase p95, including handshake and body consumption; these ranges are not
confidence intervals or isolated ingress costs.

| Phase | Gateway p95, ms | Direct p95, ms | Errors on either path |
| --- | ---: | ---: | ---: |
| No peer operation | 7.61–9.86 | 5.06–5.35 | 0 |
| Two 32 MiB uploads | 9.23–10.66 | 5.08–6.51 | 0 |
| Peer activation | 9.41–10.17 | 4.91–6.41 | 0 |
| Recovered serving | 9.05–10.53 | 5.22–5.44 | 0 |

The deliberate controller interruptions produced 94 and 84 gateway HTTP 503 responses;
direct reads had no errors. Each interval includes stopping, a configured pause,
restarting and waiting for a correct gateway response. This demonstrates the
current routing dependency on the controller. It does not establish a production
availability target. No request errors were discarded from the raw records.

The largest recorded controller cgroup peaks were 343.8 and 341.6 MiB.
One observer CPU-throttle period was recorded during the second outage phase;
other observed phases recorded none. These observations do not establish memory
headroom or a maximum request rate.

Both runs used the same sampler, payload-size policy, pacing and logical fixture,
with fresh builds whose artifact digests differ. The first retained the older
timed qualification frame; the final run uses the public host frame without the
private native-source cache. Their original source archives remain separate; the
evidence receipt identifies the harness changes rather than presenting identical
full source versions.

An earlier attempt used one padding asset above the native 25 MiB per-file limit
and failed at publication. It is not a completed measurement. Its command and
observer records and eight volumes were retained; service logs were not captured.
The harness now retains available service logs before failure cleanup. A separate
intentional-failure control verified private log retention, original-error identity
and cleanup without removing any volume.

## Write workload and response reconciliation

Run the write probe from a prepared checkout with the same cached prerequisites:

```sh
node scripts/operator/serving-writes.mjs .fogd/write-serving-observation-01
```

It copies the guestbook into private fixtures and adds a D1 table and a public
measurement-only route to those copies. It leaves the original example and existing
installations unchanged. Each POST uses a unique operation ID. The handler awaits
one insert before returning that ID and its app name. The sampler sends each write
once; it follows no redirects and never replays a failed or timed-out mutation.

A separate control deliberately returns HTTP 502 after inserting its row. This
checks that response failure and an absent write are distinguishable. That control
is excluded from latency distributions. A short read control also exercises the
default complete-body hash check on both paths.

Two workers per path use the same five-second deadline and 100-millisecond pause
as the read workload. The phases are one approved app, approval of an idle peer,
two approved apps with that peer idle, two concurrent maximum-size peer uploads,
compatible peer activation, controller interruption, and recovered writes. Minimum
windows are 10, 45, 10, 20, 45, 30 and 10 seconds. This measures one writing app
alongside an idle or deploying peer, not two applications generating write traffic.
The observer continues through longer actions and their recorded tail.

After each phase, the harness retains the samples before making exactly one ledger
read. It records that read's status and elapsed time, full row list, phase-scoped
reconciliation, and cumulative reconciliation including earlier attempts and the
control. A missing acknowledged row fails the run with that first observation
retained; the harness does not poll until it disappears. Unacknowledged operations
retain their IDs and HTTP status and are classified by presence in that read.
An absent unacknowledged operation can appear in a later snapshot if its handler
continues after the client deadline. Every classification is tied to its observation
point; it is not proof of a failed transaction or permission to retry blindly.

The peer's table must remain empty and its slot must differ from the baseline's.
The baseline release must stay unchanged. Interference errors on either path remain
measurements; healthy one-app, idle-peer and recovered windows require correct
responses. Completion does not establish zero-error serving during controller loss.

Each phase retains resource counters for the gateway, controller, storage server
and both replica pairs, with container start times and configured cgroup limits.
These counters include measurement-command overhead. Peaks are cumulative within
one container start, not phase-specific application RSS. Host load and engine
resources are start-of-run snapshots; the host and VM are shared with other workloads. Container
CPU limits do not establish per-worker isolation or CPU budgets. This paced workload
measures neither saturation nor the maximum safe number of applications.

### Legacy write-run status

The [write evidence record](evidence/operator-write-serving-local.json) records no
accepted write-performance baseline. The corrected trial completed all seven
observation phases and retained every acknowledged row in its first ledger reads,
but replica logs contained storage HTTP 507 responses. The native health check
therefore failed. A read-only check of its retained bucket volume afterward found
about 0.6 GB available on Docker's backing filesystem. Available space on the host
filesystem alone does not establish headroom inside the Docker engine.

The [declared storage source](https://github.com/minio/minio/blob/RELEASE.2025-10-15T17-29-55Z/cmd/api-errors.go#L1276-L1280)
maps the storage-full response to its minimum-free-space refusal. The observation
is consistent with storage pressure, but was taken after the errors. No retained
data was removed and no storage threshold was lowered. Repeat acceptance requires
sufficient backing-filesystem headroom and a complete run without native health
failures. These failed-run observations are not a latency or capacity recommendation.

An earlier reported pass used ledger polling and is rejected as measurement
evidence. Another attempt failed on missing test-certificate hostname coverage;
the test certificate now covers the peer and TLS verification stays enabled.
All attempt volumes and raw diagnostics remain retained.

### Durable candidate write observations

The [durable write evidence](evidence/operator-durable-write-serving-local.json)
records two completed native runs with fresh installations of
`celld-durable-v3-linux-arm64`. Explicit internal qualification uses:

```sh
node scripts/operator/serving-writes.mjs --runtime celld-durable-v3-linux-arm64 \
  --candidate --retain-resources /private/new-write-observation
```

Candidate qualification requires an explicit shipped family. Omitting `--candidate`
refuses this family under ordinary admission. The default command still selects
the qualified legacy family. `--retain-resources` stops the probe's containers and
observer while keeping its containers, networks and volumes, including on failure.
It does not stop existing installations. Without that flag, cleanup removes only
the probe's containers and networks and retains all volumes.

Both runs used a shared Linux arm64 Docker engine with two vCPUs, approximately
5.8 GiB of memory, classic overlay2 and 21 unrelated running containers. The
physical host was also busy; recorded one-minute load averages were 33.65 and
20.14 at the workload snapshots. Docker backing-filesystem observations during
uploads retained 26.84 and 26.70 GB available. These are shared-host observations,
not isolated performance comparisons with the earlier legacy runs.

The seven write phases acknowledged 5,998 and 5,674 operations. Every acknowledged
operation appeared in the first ledger read after its phase. Each run's separate
post-commit HTTP 502 control also appeared as committed. Neither run had a sampled
write error or another unknown outcome. Raw observer exits, summaries, seven ledger
snapshots per run, archived source hashes, native logs and retained container
identities were checked independently of the reported pass. Native shutdown and
storage-error checks passed. The inventories of 248 and 257 unrelated containers
remained unchanged from fixture preparation through shutdown.

The table gives the range of the two runs' whole-phase p95 values, including body
consumption. These ranges are not confidence intervals or isolated ingress costs.

| Phase | Gateway p95, ms | Direct p95, ms | Errors on either path |
| --- | ---: | ---: | ---: |
| One approved app | 21.21–52.22 | 18.77–37.76 | 0 |
| Peer approval | 29.54–63.12 | 24.35–52.54 | 0 |
| Two approved apps, peer idle | 35.41–78.97 | 27.63–60.08 | 0 |
| Two 32 MiB uploads | 34.21–79.98 | 20.88–59.29 | 0 |
| Peer activation | 30.80–53.92 | 22.67–43.66 | 0 |
| Controller interruption | 15.82–50.77 | 11.19–39.04 | 0 |
| Recovered writes | 15.70–86.38 | 12.16–62.21 | 0 |

Durable routing requires zero sampled errors on both paths during controller
interruption. Its unchanged approved app kept serving throughout both 30-second
observation windows; the recorded stop/start action intervals were 5.74 and
5.76 seconds. The baseline approval remained unchanged and the peer's table stayed
empty. Each run retained eight installation containers, one stopped observer, three
networks and eleven volumes.

This accepts the bounded candidate workload, while the failed legacy write trial
remains unaccepted. It does not open ordinary candidate admission or qualify
concurrent application writers, broader app counts, saturation, density limits,
separate-machine operation or production availability. Container CPU limits do not
establish per-worker budgets. The variation between runs is another reason to
retain the workload and resource records rather than choose a capacity limit here.

### Two apps writing concurrently

The [concurrent write evidence](evidence/operator-concurrent-write-serving-local.json)
records two native runs with both approved apps writing on separate fleets:

```sh
node scripts/operator/concurrent-writes.mjs --runtime celld-durable-v3-linux-arm64 \
  --candidate --retain-resources /private/new-concurrent-write-observation
```

This command shares the fixtures, interference actions and first-read ledger checks
with the one-writer probe. It approves both apps before observation and measures
idle operation, two simultaneous 32 MiB peer uploads, peer activation, controller
interruption and recovered operation. Minimum windows are 10, 20, 45, 30 and
10 seconds. There are two workers per path per app, eight workers in total, with
the same deadlines and pacing. Each app has its own observer, limited to one CPU
and 128 MiB. These are container limits, not application worker budgets.

Both observers must be ready before a single shared interference action starts.
Each observer records markers with its own monotonic request clock. The probe maps
request intervals onto the common engine clock and requires their shared window to
cover at least the phase minimum minus two seconds. The measured overlaps were
9.89–10.00, 19.90–19.94, 44.96–44.97, and 29.93 seconds for the corresponding
10-, 20-, 45-, and 30-second windows. These observations concern one engine;
they do not establish clock alignment across machines.

The apps intentionally use matching operation IDs, including the post-commit error
control. Correct responses must name the intended app and operation. Each app's
ledger must contain its own app label, reject foreign or unexpected rows, and retain
every acknowledged write. Each phase records one ledger read per app after both
observers finish. Raw records retain rejected operations and unknown outcomes.
The probe never replays them or polls a missing acknowledgment away.

Both runs used the same shared two-vCPU, approximately 5.8 GiB arm64 Docker engine,
with classic overlay2 and 21 unrelated running containers. Backing-filesystem
observations retained about 26.5 GB available. The physical host's recorded
one-minute load averages were 17.42 and 16.50. This remains a paced shared-host
measurement, not a saturation test or an isolated cost comparison.

The table gives whole-phase p95 ranges across both apps and both runs. Error counts
sum both apps and runs, excluding the four deliberate post-commit controls. Latency
distributions include failed requests. These ranges are not confidence intervals.

| Phase | Gateway p95, ms | Direct p95, ms | Gateway errors | Direct errors |
| --- | ---: | ---: | ---: | ---: |
| Two writing apps | 30.51–82.59 | 22.98–58.73 | 0 | 0 |
| Peer uploads | 35.95–79.70 | 26.90–69.87 | 0 | 0 |
| Peer activation | 40.60–78.81 | 29.39–62.52 | 48 | 0 |
| Controller interruption | 38.16–107.80 | 28.68–89.67 | 0 | 0 |
| Recovered writes | 41.94–107.65 | 34.47–71.92 | 0 | 0 |

Whole-phase observed rates ranged from 13.22 to 17.56 requests per second for each
app's gateway path and 14.31 to 17.90 for each direct path. The receipt retains
per-phase rates, durations, response counts, distributions and resource counters.
Closed-loop pacing lowers the offered rate as responses slow; these rates are not
maximum throughput or density recommendations.

All 14,816 acknowledged writes appeared in their first ledger reads. Each app's
post-commit HTTP 502 control also appeared as committed in both runs. The updating
app received 24 gateway HTTP 503 responses per run during activation. Those IDs
were absent at the retained snapshots, including the final reads. Their later
absence is not permission to replay mutations blindly. The unchanged app had no
sampled errors. Both apps had no sampled errors during controller interruption.
Direct replica traffic bypasses ingress withholding, so its successful writes do
not establish public availability during the peer update.

Independent checks verified twelve observer exits, ten first-read phase ledgers,
940 archived source files, the actual installed policy volume and complete native
logs per run. Each run retained eight stopped installation containers, two stopped
observers, three networks and eleven volumes. Inventories of 266 and 276 unrelated
containers stayed unchanged from their recorded checkpoints during the runs.

This completes the bounded two-writer observation while documenting an activation
interruption. It does not qualify zero-downtime updates, broader app counts,
saturation, density limits or ordinary candidate admission. The failed legacy
write trial remains unaccepted.
