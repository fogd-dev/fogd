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

Gateway errors during controller interruption are expected evidence of the current
routing dependency. Direct reads must continue and recovered gateway reads must
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

The deliberate controller interruptions produced 94 and 84 gateway HTTP 503s;
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
