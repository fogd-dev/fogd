#!/usr/bin/env node
import { expansionCommand } from '../src/recovery/expand.mjs';
import { dockerCommand } from '../src/compose/render.mjs';
import { retirementCommand } from '../src/recovery/retire.mjs';
import { kubernetesCommand } from '../src/kubernetes/commands.mjs';
import { importTLS } from '../src/tls.mjs';
import { backup } from '../src/recovery/backup.mjs';
import { restore } from '../src/recovery/restore.mjs';
import { up, deploy, admin, adminDelivery, adminRepair, status } from '../src/platform.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'docker') {
    await dockerCommand(args);
  } else if (command === 'expand') {
    await expansionCommand(args);
  } else if (command === 'retire') {
    await retirementCommand(args);
  } else if (command === 'kube') {
    await kubernetesCommand(args);
  } else if (command === 'backup') {
    if (args.length !== 1) throw new Error('Usage: fogd backup DIRECTORY');
    await backup(args[0]);
  } else if (command === 'restore') {
    if (args.length !== 5 || args[1] !== '--project' || args[3] !== '--output') throw new Error('Usage: fogd restore DIRECTORY --project NAME --output DIRECTORY');
    await restore(args[0], args[2], args[4]);
  } else if (command === 'tls') {
    if (args.length !== 3 || args[0] !== 'import') throw new Error('Usage: fogd tls import CERTIFICATE_PEM PRIVATE_KEY_PEM');
    await importTLS(args[1], args[2]);
  } else if (command === 'up') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--shared')) throw new Error('Usage: fogd up [--shared]');
    await up(args[0] === '--shared');
  }
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
    if (args[0] === 'repair') {
      if (args.length > 6) throw new Error('Too many repair arguments');
      await adminRepair(...args.slice(1));
    } else if (args[0] === 'delivery') {
      if (args.length > 5) throw new Error('Too many delivery arguments');
      await adminDelivery(...args.slice(1));
    } else {
      if (args.length > 4) throw new Error('Too many admin arguments');
      await admin(...args);
    }
  }
  else if (!command || command === '--help' || command === 'help') {
    console.log('fogd docker render DIRECTORY --fleets 2|3  Write an unresolved Compose template\nfogd expand BUNDLE --fleets 3 --project NEW --output DIR\n                           Expand into a fresh stopped installation\nfogd retire BUNDLE --app NAME --digest SHA --project NEW --output DIR\n                           Retire into a fresh stopped Docker installation\nfogd kube render DIR --cert CERT --key KEY  Write experimental Kubernetes manifests\nfogd kube backup INSTALLATION BUNDLE --kubeconfig FILE --context NAME\nfogd kube restore BUNDLE --namespace NAME --output DIR --kubeconfig FILE --context NAME\nfogd backup DIRECTORY      Stop and snapshot the local installation\nfogd restore DIRECTORY --project NAME --output DIRECTORY\n                           Restore onto fresh stopped volumes\nfogd tls import CERT KEY   Install a certificate while stopped\nfogd up [--shared]         Start the local or TLS/scoped Docker stack\nfogd deploy [--name app]   Build and submit the current Void app for approval\nfogd status ID             Inspect a submission using its deploy credential\nfogd admin capacity        Inspect slot, pending, and artifact limits\nfogd admin delivery APP [status|observe|pause|resume ID SHA]  Control queue delivery\nfogd admin list            List submissions and secret revision names\nfogd admin issue-token NAME APP[,APP]  Issue a scoped deploy token once\nfogd admin revoke-token ID  Revoke a deploy credential\nfogd admin secrets APP     Replace secrets from JSON on stdin\nfogd admin approve ID SHA [REV]  Approve exact artifact and secret revision\nfogd admin repair NEW_ID NEW_SHA HELD_ID HELD_SHA [REV]  Approve a corrected artifact\nfogd admin reject ID SHA   Reject an artifact\n\nSet FOGD_HOME to the fogd checkout when using the CLI elsewhere.');
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(`fogd: ${error.message}`); process.exitCode = 1; }
