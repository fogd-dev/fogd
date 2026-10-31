import { parseArgs } from 'node:util';
import { uuid } from '../build-cache/paths.mjs';
import { preparePreview } from './prepare.mjs';

async function storageCommand([action, ...args]) {
  if (action === 'prepare') {
    const { previewSetupCommand } = await import('./setup-command.mjs');
    return previewSetupCommand('storage', args);
  }
  if (['inspect', 'reconcile'].includes(action)) {
    const { previewStorageRecoveryCommand } = await import('./storage-recovery-command.mjs');
    return previewStorageRecoveryCommand(action, args);
  }
  throw new Error('Usage: fogd preview storage prepare|inspect|reconcile [options]');
}
export async function previewCommand(args) {
  if (args[0] === 'storage') return storageCommand(args.slice(1));
  if (args[0] === 'request') {
    const { previewSetupCommand } = await import('./setup-command.mjs');
    return previewSetupCommand('request', args.slice(1));
  }
  if (args[0] === 'profile') {
    const { previewProfileCommand } = await import('./profile-command.mjs');
    return previewProfileCommand(args[1], args.slice(2));
  }
  if (args[0] === 'launch') {
    const { previewLaunchCommand } = await import('./launch-command.mjs');
    return previewLaunchCommand(args.slice(1));
  }
  if (['status', 'stop', 'retire'].includes(args[0])) {
    const { previewOwnerCommand } = await import('./owner-command.mjs');
    return previewOwnerCommand(args[0], args.slice(1));
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    output: { type: 'string' }, runtime: { type: 'string' }, 'lifetime-seconds': { type: 'string' },
  } });
  if (positionals.length !== 2 || positionals[0] !== 'prepare' || !uuid(positionals[1]) || !values.output || !values.runtime || !values['lifetime-seconds']) throw new Error('Usage: fogd preview prepare ID --runtime FAMILY --lifetime-seconds SECONDS --output NEW_PRIVATE_DIRECTORY');
  console.log(JSON.stringify(await preparePreview({ id: positionals[1], output: values.output, runtime: values.runtime, lifetimeSeconds: values['lifetime-seconds'] }), null, 2));
}
