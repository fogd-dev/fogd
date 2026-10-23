import { docker } from '../recovery/docker.mjs';

export class ObserverCleanupError extends Error {}
export async function cleanupObserver(name, nonce) {
  const selection = ['ps', '-aq', '--filter', `name=^/${name}$`, '--filter', `label=fogd.observer.id=${nonce}`];
  try {
    const ids = (await docker(selection, { timeoutMs: 5000 })).trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return;
    if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/.test(ids[0])) throw new Error();
    await docker(['rm', '-f', ids[0]], { timeoutMs: 5000 });
    if ((await docker(selection, { timeoutMs: 5000 })).trim()) throw new Error();
  } catch { throw new ObserverCleanupError(`Observation helper cleanup is unconfirmed; inspect local container ${name}`); }
}
