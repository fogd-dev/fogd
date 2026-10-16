#!/usr/bin/env node
import { backup } from '../src/recovery/backup.mjs';
import { restore } from '../src/recovery/restore.mjs';
import { up, deploy, admin, status } from '../src/platform.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'backup') {
    if (args.length !== 1) throw new Error('Usage: fogd backup DIRECTORY');
    await backup(args[0]);
  } else if (command === 'restore') {
    if (args.length !== 5 || args[1] !== '--project' || args[3] !== '--output') throw new Error('Usage: fogd restore DIRECTORY --project NAME --output DIRECTORY');
    await restore(args[0], args[2], args[4]);
  } else if (command === 'up') await up();
  else if (command === 'deploy') {
    const nameIndex = args.indexOf('--name');
    const name = nameIndex === -1 ? undefined : args[nameIndex + 1];
    if (nameIndex !== -1 && !name) throw new Error('--name requires a value');
    if ((nameIndex === -1 && args.length) || (nameIndex !== -1 && (nameIndex !== 0 || args.length !== 2))) throw new Error('Usage: fogd deploy [--name app]');
    await deploy(process.cwd(), name);
  } else if (command === 'status') {
    if (args.length !== 1) throw new Error('Usage: fogd status <deployment-id>');
    await status(args[0]);
  } else if (command === 'admin') {
    if (args.length > 4) throw new Error('Too many admin arguments');
    await admin(...args);
  }
  else if (!command || command === '--help' || command === 'help') {
    console.log('fogd backup DIRECTORY      Stop and snapshot the local installation\nfogd restore DIRECTORY --project NAME --output DIRECTORY\n                           Restore onto fresh stopped volumes\nfogd up                    Start the local Docker stack\nfogd deploy [--name app]   Build and submit the current Void app for approval\nfogd status ID             Inspect a submission using its deploy credential\nfogd admin list            List submissions and secret revision names\nfogd admin issue-token NAME APP[,APP]  Issue a scoped deploy token once\nfogd admin revoke-token ID  Revoke a deploy credential\nfogd admin secrets APP     Replace secrets from JSON on stdin\nfogd admin approve ID SHA [REV]  Approve exact artifact and secret revision\nfogd admin reject ID SHA   Reject an artifact\n\nSet FOGD_HOME to the fogd checkout when using the CLI elsewhere.');
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(`fogd: ${error.message}`); process.exitCode = 1; }
