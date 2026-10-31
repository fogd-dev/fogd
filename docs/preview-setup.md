# Preview storage and request commands

Fogd connects an exact prepared proposal to profile-bound storage and a signed
launch request. The current preview runtime remains a candidate: both public
setup commands refuse it before Docker or SSH calls. Ordinary live preview use
remains closed until its acceptance gates pass. There is no CLI or environment
option to enable a candidate.

Use the operator CLI with a [host profile](previews.md#preview-host-profiles), its
original fingerprint, a [verified preparation](previews.md#prepare-an-exact-submission)
and the source administrator environment. A live preparation must identify an
admitted preview runtime; archive-family preparations are review inputs only.
The runtime comes from that preparation and cannot be replaced by settings.

## Prepare bounded storage

```sh
fogd preview storage prepare \
  --profile PROFILE_DIRECTORY --expected-profile ORIGINAL_PROFILE_SHA256 \
  --preparation PREPARATION_DIRECTORY --expected-preparation ORIGINAL_PREPARATION_SHA256 \
  --storage-host owned-linux \
  --output NEW_PRIVATE_STORAGE_REQUEST_DIRECTORY
```

The command verifies the profile, current engine/budget, actual prepared artifacts,
execution-profile compatibility and current source before provisioning. Background-
capable bindings that the execution profile refuses cannot consume a storage slot. It records local intent before host
effects, creates a bounded empty filesystem under the engine-wide storage policy,
retains its returned receipt, and publishes completion only after checking the
actual empty role directories.
It starts no container, reserves no memory and grants no execution permission.

Keep the returned `storageRequestSha256` independently. It fingerprints the
completion record, which binds both the provisioning intent and storage receipt.
The inner filesystem receipt has a different fingerprint; it cannot substitute
for the original storage-request fingerprint.

A partial or uncertain operation retains its local intent, any returned receipt,
any host fence and charge. Repeating the same output refuses before transports. A new
output cannot overwrite an existing project's storage. Preserve these records for
explicit recovery; this command cannot resume, reclaim or reset them.

## Inspect and complete retained local storage setup

Use `storage inspect` when provisioning has already completed on the host but its
local receipt or completion record is missing. Keep the original initialization
record, profile and preparation fingerprints. Inspection checks the exact engine,
policy, charged filesystem and empty role directories without source credentials
or runtime admission. It returns a review snapshot and its `reviewSha256`.

```sh
fogd preview storage inspect \
  --profile PROFILE_DIRECTORY --expected-profile ORIGINAL_PROFILE_SHA256 \
  --preparation PREPARATION_DIRECTORY --expected-preparation ORIGINAL_PREPARATION_SHA256 \
  --storage-request STORAGE_REQUEST_DIRECTORY --storage-host owned-linux
```

Review the returned binding, actual storage and local file identities. To complete
only the missing local receipt or completion, supply that exact review fingerprint:

```sh
fogd preview storage reconcile \
  --profile PROFILE_DIRECTORY --expected-profile ORIGINAL_PROFILE_SHA256 \
  --preparation PREPARATION_DIRECTORY --expected-preparation ORIGINAL_PREPARATION_SHA256 \
  --storage-request STORAGE_REQUEST_DIRECTORY --storage-host owned-linux \
  --expected-review REVIEW_SHA256
```

Reconciliation records the accepted snapshot before filling missing files. Existing
records must keep their bytes and inodes. A repeated accepted recovery rechecks the
host and returns the same completion fingerprint without replacing local files.
Keep the returned `storageRequestSha256` for request creation. That workflow still
requires its own current source and runtime admission checks.

These commands never provision storage, clear a pending host operation, reserve
memory or start an application. A pending profile/storage fence, any historical
memory reservation for this preview, nonempty storage or corrupt local metadata
refuses while retaining all records and charges. Once the host and profile are
settled, a valid recovery acknowledgment can complete its remaining missing files.
Process loss that leaves a profile checking fence, or a partial/corrupt local file,
requires separate recovery; these commands do not clear or repair those records.

The [storage setup recovery qualification](evidence/operator-preview-storage-setup-recovery.json)
uses owned local incomplete-record fixtures referencing an already completed empty
Linux ARM64 filesystem. It verifies the public CLI, retained original request,
read-only host observations and repeated local completion. It does not qualify
interrupted host provisioning, application restoration or crash-fence recovery.

## Create a launch request

Provide a private settings file with the preview URL, four subnets, TLS file paths
and preview-only secret values. This example uses placeholders for the prepared
app and preview UUID; remove dashes from the UUID when forming the hostname.
The certificate names must match that exact hostname.

```json
{
  "origin": "https://APP.PREVIEW_ID.preview.test:49579",
  "subnets": {
    "control": "10.228.31.0/24",
    "fleet-1": "10.228.32.0/24",
    "fleet-2": "10.228.33.0/24",
    "frontend": "10.228.34.0/24"
  },
  "tls": {
    "gateway": { "certFile": "tls/gateway.crt", "keyFile": "tls/gateway.key" },
    "ingress": { "certFile": "tls/ingress.crt", "keyFile": "tls/ingress.key" }
  },
  "secrets": {}
}
```

Choose unused private subnets and a free ingress port. Launch checks actual
placement and capacity again. TLS paths resolve relative to the settings file;
absolute paths are also accepted. Settings and TLS files must be regular,
singly linked, owner-only `0600` files in owned `0700` directories. Settings can
use ordinary JSON formatting. The source vault and administrator environment are
never used as preview secret values. Supply exactly the names required by the
prepared application, with separate preview values.

```sh
fogd preview request \
  --profile PROFILE_DIRECTORY --expected-profile ORIGINAL_PROFILE_SHA256 \
  --preparation PREPARATION_DIRECTORY --expected-preparation ORIGINAL_PREPARATION_SHA256 \
  --storage-request STORAGE_REQUEST_DIRECTORY --expected-storage-request ORIGINAL_STORAGE_REQUEST_SHA256 \
  --settings /private/preview-settings.json \
  --storage-host owned-linux --output NEW_PRIVATE_LAUNCH_REQUEST_DIRECTORY
```

The command checks the exact profile/preparation/storage binding and rechecks
actual empty storage and current source. It generates a fresh signing authority,
storage password, gateway token and viewer key. The signing private key and source
credentials are absent from the saved request. Request files still contain
preview credentials, TLS private keys and application code; preserve their private
permissions. The returned request fingerprint binds the complete launch inputs.

Request creation starts the signed lifetime; it reserves no memory and starts no
application. A request cannot renew its original expiry. A receipt from another
profile or preparation refuses, as do altered, incomplete or relocated records.
Output must be fresh and outside the profile, preparation and storage-request
directories. Refusal retains the original storage charge and files.

## Launch boundary

Pass the returned directory/fingerprint to the [foreground launch command](previews.md#foreground-launch-command)
when runtime admission permits it. That command repeats source, storage, resource
and capacity checks, installs private owner controls, and owns managed shutdown.
A signed request alone is neither readiness nor production activation. Production
activation remains a separate exact-artifact decision; preview data is retained
and cannot become production data implicitly.

The [setup qualification](evidence/operator-preview-setup.json) covers actual
bounded storage and signed request generation through an explicit internal
candidate API on a Linux ARM64 QA engine. The public commands refuse that candidate
without transports. The source is an owned HTTP fixture. There are no application
images, containers, volumes or memory reservations in this trial. It qualifies
setup, not native foreground launch, ordinary runtime admission or complete
browser/production-preservation acceptance. Default cron admission remains closed.
