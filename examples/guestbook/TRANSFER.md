# Grow and transfer the guestbook

Run these commands from the fogd repository with Node and pnpm installed as in
[README](../../README.md). The fixture adds file attachments to the native Void
guestbook, preserves its messages, and moves logical data into another app.

## Automated qualification

Use a disposable stack with both app slots empty. Stop any other fogd stack using
the same ports first. Select its Compose project in `.env`, then run:

```sh
pnpm install --frozen-lockfile
pnpm fogd up
node scripts/growth-smoke.mjs
```

The script deploys `guestbook`, writes through the browser, prepares and approves
an attachment update, verifies upload/download, and deploys `restored` in the
second slot. It stops public ingress, restarts the participating replicas, and
exports messages and referenced object bytes. It rejects corrupt input, injects
a destination SQL failure after object writes, retries, and compares the restored
data. It resumes ingress, writes a new message, and restarts controller/workerd.
Both applications remain deployed. The test requires the Chromium installation
from the [guestbook guide](README.md).

The snapshot is `.fogd/growth/snapshot.json`; it contains application data and
has owner-only permissions when created. This fixture accepts at most 100 messages,
100 attachments, 64 KiB per file, 1 MiB total file bytes, and 2 MiB compact JSON.

## Prepare an update manually

With the original guestbook already approved, choose a new destination directory:

```sh
node scripts/prepare-growth.mjs .fogd/my-guestbook-update
cd .fogd/my-guestbook-update
pnpm exec fogd deploy --name guestbook
```

Approve its exact digest through the admin UI. The update adds `STORAGE`, an
attachments table, and a transfer receipt table. Existing D1 identity and messages
remain. Open the app, select a message, and upload a file. The second app must use
this same supported profile before a transfer.

## Transfer between prepared apps

Run from the repository root, with both apps active and the destination empty:

```sh
node scripts/guestbook-transfer.mjs guestbook restored .fogd/guestbook-export.json
```

Run as the only operator: do not approve deployments concurrently. This operation
stops workerd for the entire local stack and gracefully restarts both replicas of
each participating app. It checks their versions and health, exports, imports,
compares the logical data, then resumes ingress. An existing snapshot file is
accepted only when its JSON matches the current export. It is never overwritten.

If transfer fails, ingress stays stopped. Inspect the printed error and snapshot.
An interrupted restore can accept the identical snapshot again; unrelated objects,
existing application rows, and a different pending/completed digest are refused.
Rerun the command after correcting the cause. To resume without retrying:

```sh
docker compose start workerd
```

Only do that after inspecting destination state. A failed restore can leave a
pending receipt and unreferenced R2 objects, but its SQL rows and completion record
commit together. Deleting the receipt or changing a partial restore's objects is
not a supported recovery procedure. An abandoned destination requires a fresh app
on an unused slot. If both slots are occupied, there is no in-place reset command;
use another disposable installation. Do not delete valuable installation volumes.

This is an application-specific logical transfer. It excludes orphan objects,
runtime logs, and deployment metadata. It is not an installation backup, an online
snapshot, or evidence of Cloudflare-hosted restore. The fixture has no background
writers; other applications need their own quiescence and schema contracts.
