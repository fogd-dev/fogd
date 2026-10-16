#!/usr/bin/env node
import { up, deploy, admin } from '../src/platform.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'up') await up();
  else if (command === 'deploy') {
    const nameIndex = args.indexOf('--name');
    const name = nameIndex === -1 ? undefined : args[nameIndex + 1];
    if (nameIndex !== -1 && !name) throw new Error('--name requires a value');
    if ((nameIndex === -1 && args.length) || (nameIndex !== -1 && (nameIndex !== 0 || args.length !== 2))) throw new Error('Usage: fogd deploy [--name app]');
    await deploy(process.cwd(), name);
  } else if (command === 'admin') await admin(...args);
  else if (!command || command === '--help' || command === 'help') {
    console.log('fogd up                    Start the local Docker stack\nfogd deploy [--name app]   Build and submit the current Void app for approval\nfogd admin list            List submissions\nfogd admin approve ID SHA  Approve an exact artifact (also retries failures)\nfogd admin reject ID SHA   Reject an artifact\n\nSet FOGD_HOME to the fogd checkout when using the CLI elsewhere.');
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(`fogd: ${error.message}`); process.exitCode = 1; }
