import { restoreAppArchiveStores, restoreAppArchiveRecoveryStores } from './app-archive-routes.mjs';

// The stopped launcher chooses one fixed operation. JSON cannot select paths,
// executables, publishers or options; both operations share the enrollment writer.
const operations = { archive: restoreAppArchiveStores, restore: restoreAppArchiveRecoveryStores };
try {
  if (process.argv.length !== 3 || !Object.hasOwn(operations, process.argv[2])) throw new Error();
  let size = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error();
    chunks.push(chunk);
  }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
  console.log(JSON.stringify(await operations[process.argv[2]](input)));
} catch {
  process.stderr.write('App archive route restoration failed; keep ingress stopped and retain all stores\n');
  process.exitCode = 1;
}
