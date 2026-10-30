import { lstat, readdir, chmod, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash } from '../build-cache/paths.mjs';
import { previewDeadline } from './deadline.mjs';
import { previewInputGroups, previewInputPackageLimit, preparePreviewInputPackage } from './input-package.mjs';
import { executionKeys } from './execution-shape.mjs';

function checkedFiles(snapshot) {
  executionKeys(snapshot.files, previewInputGroups); executionKeys(snapshot.manifest, previewInputGroups);
  for (const group of previewInputGroups) {
    const names = group.endsWith('-trust') ? ['trust.json'] : group === 'controller-input' ? ['execution.json', 'artifact.json', 'secrets.json'] : ['execution.json', 'service.json'];
    executionKeys(snapshot.files[group], names); executionKeys(snapshot.manifest[group], names);
    for (const name of names) {
      const value = snapshot.files[group][name], expected = snapshot.manifest[group][name];
      if (typeof value !== 'string' || Buffer.byteLength(value) !== expected.bytes || hash(value) !== expected.sha256 || expected.bytes > previewInputPackageLimit) throw new Error('Invalid input snapshot');
    }
  }
}

async function syncDirectory(path) {
  const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); }
}
// One shot: inspect every directory before writing anything. Existing content is
// never overwritten or removed, including files from an interrupted attempt.
export async function writePreviewInputPackage(root, snapshot) {
  checkedFiles(snapshot);
  for (const group of previewInputGroups) {
    const path = join(root, group), info = await lstat(path);
    if (!info.isDirectory() || (await readdir(path)).length) throw new Error('Input installation requires empty owned volumes');
  }
  for (const [group, files] of Object.entries(snapshot.files)) {
    const directory = join(root, group); await chmod(directory, 0o700);
    for (const [name, bytes] of Object.entries(files)) {
      const file = await open(join(directory, name), 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      const read = await open(join(directory, name), 'r');
      try { if (hash(await read.readFile()) !== snapshot.manifest[group][name].sha256) throw new Error('Input installation readback differs'); }
      finally { await read.close(); }
    }
    await syncDirectory(directory);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let timer;
  try {
    if (process.argv.length !== 4) throw new Error();
    const expires = previewDeadline(process.argv[2]); if (expires <= Date.now()) throw new Error();
    timer = setTimeout(() => process.exit(1), expires - Date.now());
    const chunks = []; let count = 0;
    for await (const chunk of process.stdin) { count += chunk.length; if (count > previewInputPackageLimit) throw new Error(); chunks.push(chunk); }
    const snapshot = await preparePreviewInputPackage(JSON.parse(process.argv[3]), Buffer.concat(chunks));
    if (snapshot.grant.expiresAt !== process.argv[2] || Date.now() >= expires) throw new Error();
    await writePreviewInputPackage('/run/fogd-preview-stage', snapshot);
    if (Date.now() >= expires) throw new Error();
    console.log(JSON.stringify({ installed: true, packageSha256: snapshot.sha256 }));
  } catch { console.error('Preview input installation refused; retain its files and inspect the pending operation'); process.exitCode = 1; }
  finally { clearTimeout(timer); }
}
