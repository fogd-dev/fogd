import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { composeArgs } from '../../../packages/cli/src/recovery/docker.mjs';

export async function captureFailureLogs(host) {
  try {
    const config = join(host.env.FOGD_HOME, '.fogd/installations', host.project, 'compose.json');
    const logs = await host.run('docker', [...composeArgs(config, host.project), 'logs', '--no-color'], { timeout: 30000 });
    await writeFile(join(host.output, 'runtime-failure.log'), logs, { mode: 0o600, flag: 'wx' });
    return { captured: true, bytes: Buffer.byteLength(logs) };
  } catch { return { captured: false }; }
}
