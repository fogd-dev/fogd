import { join } from 'node:path';
import { docker } from './docker.mjs';

export function volumeHelper(image, volume, args, { readonly = true, ...options } = {}) {
  const caps = readonly ? ['DAC_OVERRIDE'] : ['CHOWN', 'FOWNER', 'FSETID', 'DAC_OVERRIDE'];
  return docker(['run', ...(options.input || options.inputText !== undefined ? ['-i'] : []), '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', ...caps.flatMap(cap => ['--cap-add', cap]), '--security-opt', 'no-new-privileges', '--mount', `type=volume,src=${volume},dst=/data${readonly ? ',readonly' : ''}`, image, ...args], options);
}
export async function restoreVolumes(directory, target, names, image, skipped = []) {
  for (const name of names) {
    const volume = target.volumes[name].name;
    await requireEmpty(image, volume);
    if (!skipped.includes(name)) await volumeHelper(image, volume, ['sh', '-c', 'tar --numeric-owner -C /data -xpf - && sync -f /data'], { readonly: false, input: join(directory, `${name}.tar`) });
  }
  for (const name of names.filter(name => !skipped.includes(name))) {
    await volumeHelper(image, target.volumes[name].name, ['tar', '--numeric-owner', '-C', '/data', '--compare', '-pf', '-'], { input: join(directory, `${name}.tar`) });
  }
  for (const name of names.filter(name => skipped.includes(name))) await requireEmpty(image, target.volumes[name].name);
}

async function requireEmpty(image, volume) {
  if ((await volumeHelper(image, volume, ['find', '/data', '-mindepth', '1', '-maxdepth', '1', '-print', '-quit'])).length) throw new Error('Restore requires empty target volumes');
}
