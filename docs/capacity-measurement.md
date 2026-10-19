# Measure a Docker installation

Use the repository scripts to observe a running fogd Compose project and a bounded
read workload. These measurements support operator planning; they do not determine
maximum app density or qualify an expanded installation.

## Capture a warm idle window

Choose the project explicitly. Keep the host awake for the measurement and avoid
other fogd traffic. Existing resident cells and caches affect warm memory usage.
The capture reads statistics and briefly executes Node in the controller to read
VM memory information. It does not change configuration or persisted data.

```sh
node scripts/capacity.mjs --project YOUR_PROJECT \
  --output .fogd/warm-idle.json --samples 12 --interval 5000
```

`--interval` is the delay in milliseconds after each observation. Docker collection
takes additional time; reports contain actual timestamps and elapsed monotonic time.
Use a new output filename for every run. The output path is reserved before collection; existing files are never overwritten.
A failed or interrupted capture can leave an empty or incomplete file. Only a
complete JSON report from a successful process is measurement evidence.
The script rejects missing or duplicated services, incomplete replica pairs,
container restarts/replacements, long observation gaps, and malformed statistics.
The exited bucket initializer is excluded; a running initializer is refused.

The report includes image identities, memory/CPU ceilings, restart counts, Docker
engine capacity, VM memory/swap information at capture start, and unrelated running
container count. It excludes credentials and full container inspection output.
It does not verify that live mounts or environment match a deployment configuration;
stopped backup performs that separate preflight.

## Capture a read workload

Choose an existing read-only endpoint with bounded data and no credentials in its
path: the report retains the endpoint URL. For the notebook example,
`/api/entries` reads D1 rows, R2 bodies, and the Durable Object count. Use a fixture
with a small fixed number of entries. The load script sends GET requests only, but
operators must ensure the selected endpoint does not mutate state.

Start the load in one terminal, using the installation CA for HTTPS:

```sh
NODE_EXTRA_CA_CERTS=/path/to/ca.pem node scripts/capacity/load.mjs \
  --url https://APP.YOUR_DOMAIN:8787/api/entries \
  --output .fogd/read-requests.json --seconds 120 --concurrency 4 --delay 100
```

While it runs, capture metrics in another terminal:

```sh
node scripts/capacity.mjs --project YOUR_PROJECT \
  --output .fogd/read-metrics.json --samples 12 --interval 5000
```

Confirm all metric sample timestamps fall inside the request window. Repeat the
warm idle capture after load to observe retained memory. Keep workload per app
constant when comparing fleet counts; the total load must increase with app count.
A cold-start comparison requires a separate controlled restart and workload history.

Each worker waits `--delay` milliseconds after a response, so this is a paced,
closed-loop workload. It is not a fixed arrival rate or saturation test. Redirects,
non-200 responses, timeouts, and bodies exceeding 1 MiB count as errors and produce
a nonzero exit after recording the report. TLS verification stays enabled. Reports
contain response counts and latency percentiles, not response bodies or credentials.
Inspect errors before interpreting throughput. A 200 response alone does not prove
application correctness; use the app's separate acceptance tests.

## Interpret the results

Docker CLI memory usage excludes some cache on Linux. It is neither process RSS
nor a peak-memory measurement. CPU 100% represents one full core. Each Docker CPU statistic uses its own short
sampling window; it is not an average across the requested observation interval. Group summaries
sum simultaneous samples before reporting minima and maxima; they do not add
unrelated per-container peaks. Configured ceilings are not reservations.

The default two-fleet installation has 3584 MiB of memory ceilings and 8 CPU cores
of ceilings across its seven long-running containers. Four celld replicas account
for 2048 MiB and 4 cores. The third fleet adds 1024 MiB and 2
cores of ceilings, plus two persistent volumes. Observed spare memory does not
establish safe workload density. Budget disk for live data, replica logs, artifacts,
backups, and simultaneous source/target volumes during fresh recovery.

Docker Desktop measurements describe its VM. Other containers, host activity,
swap, resident cells, request mix, and data size affect results. Swap information
is a point-in-time VM observation, not a per-app attribution or a thrashing test.
See [expansion](expansion.md) for qualified three-fleet operation and recovery.
First-request cold-start latency, write-heavy workloads, and maximum safe density
remain unmeasured.

## Paired two/three-fleet observations

The [2026-10-19 reports](evidence/m10c-paired-capacity.json) cover sequential
restarts of the two-fleet source and its three-fleet expansion. Each app received
four paced clients for 120 seconds, with 100 ms delay after each response. The
accounts app served its home page; each notebook app read one D1/R2/DO entry.
All sampled load windows fall inside every app's request window. There were zero
HTTP errors. The third app adds load; existing per-app client settings stay fixed.

| Window | Two fleets: observed memory / mean sampled CPU | Three fleets: observed memory / mean sampled CPU |
| --- | --- | --- |
| Restarted idle, six samples | 310–320 MiB / 2.36% | 340–350 MiB / 4.29% |
| Reads, twelve samples | 372–679 MiB / 37.63% | 435–830 MiB / 72.38% |
| Warm idle after reads, six samples | 596–672 MiB / 3.33% | 708–782 MiB / 4.96% |

CPU 100% is one core. These are sampled Docker totals; the report also separates
shared services and each app fleet. Default configured memory ceilings increase
from 3584 to 4608 MiB, CPU ceilings from 8 to 10 cores, and running containers from
seven to nine. Two replica volumes are added. Observed usage is much lower than
those ceilings for this small read workload; it does not establish headroom for
arbitrary apps.

At two fleets the accounts/notebook p95 latencies were 15.7/17.3 ms. At three fleets
they were 35.4/54.2 ms; inspect the report for the added app and all percentiles.
The VM had 10 CPUs, about 15.6 GiB RAM, and nine unrelated running containers.
The phases ran sequentially with slightly different account history. No heavy
fogd build/test work was deliberately run during the pair, but the host and VM
were shared. Do not attribute the difference solely to adding a fleet. Restarted
idle follows readiness probes and is not a first-request cold-start measurement.

To reproduce on disposable qualified fixtures, select the current installation's
environment, project, and Compose file; set an absolute `NODE_EXTRA_CA_CERTS` path.
Then run:

```sh
node scripts/capacity-comparison.mjs TWO_FLEET_COMPOSE THREE_FLEET_COMPOSE OUTPUT_DIR
```

The script stops the selected current installation, runs each source in turn, and
restarts the original in `finally`. Fixtures must contain `accounts` and
`replacement`, plus `third` in the expanded source. They share the selected
operator credentials and certificate. Keep source and expanded installations
stopped outside their phase. Check original app readiness afterward; Compose
startup alone does not establish it.
