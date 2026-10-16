#!/usr/bin/env node
import { up, deployLocal } from '../src/local.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'up') await up();
  else if (command === 'deploy') {
    const nameIndex = args.indexOf('--name');
    const name = nameIndex === -1 ? undefined : args[nameIndex + 1];
    if (nameIndex !== -1 && !name) throw new Error('--name requires a value');
    if (args.some((value, index) => index !== nameIndex && index !== nameIndex + 1)) throw new Error('Usage: fogd deploy [--name app]');
    await deployLocal(process.cwd(), name);
  } else if (!command || command === '--help' || command === 'help') {
    console.log('fogd up                    Start the local Docker stack\nfogd deploy [--name app]   Build and deploy the current Void app\n\nSet FOGD_HOME to the fogd checkout when using the CLI elsewhere.');
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(`fogd: ${error.message}`); process.exitCode = 1; }
