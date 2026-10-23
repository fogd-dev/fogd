#!/usr/bin/env node
import { clientCommand } from '../src/client/command.mjs';
import { reviewCommand } from '../src/review/command.mjs';
import { startupOptions } from '../src/runtime/startup-options.mjs';
import { observeCommand } from '../src/observe/command.mjs';
import { buildsCommand } from '../src/build-cache/command.mjs';
import { runtimeCommand } from '../src/distribution/command.mjs';
import { expansionCommand } from '../src/recovery/expand.mjs';
import { dockerCommand } from '../src/compose/render.mjs';
import { retirementCommand } from '../src/recovery/retire.mjs';
import { kubernetesCommand } from '../src/kubernetes/commands.mjs';
import { importTLS } from '../src/tls.mjs';
import { backup } from '../src/recovery/backup.mjs';
import { restoreCommand } from '../src/recovery/restore.mjs';
import { upInstallation } from '../src/runtime/start-installation.mjs';
import { parseArgs } from 'node:util';
import { up, deploy, admin, adminDelivery, adminDispatch, adminRepair, adminAcknowledgeRecovery, status } from '../src/platform.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'client') {
    await clientCommand(args);
  } else if (command === 'observe') {
    await observeCommand(args);
  } else if (command === 'builds') {
    await buildsCommand(args);
  } else if (command === 'runtime') {
    await runtimeCommand(args);
  } else if (command === 'docker') {
    await dockerCommand(args);
  } else if (command === 'expand') {
    await expansionCommand(args);
  } else if (command === 'retire') {
    await retirementCommand(args);
  } else if (command === 'kube') {
    await kubernetesCommand(args);
  } else if (command === 'backup') {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { installation: { type: 'string' } } });
    if (positionals.length !== 1 || values.installation === '') throw new Error('Usage: fogd backup DIRECTORY [--installation PROJECT]');
    await backup(positionals[0], values.installation);
  } else if (command === 'restore') {
    await restoreCommand(args);
  } else if (command === 'tls') {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { installation: { type: 'string' } } });
    if (positionals.length !== 3 || positionals[0] !== 'import' || values.installation === '') throw new Error('Usage: fogd tls import CERTIFICATE_PEM PRIVATE_KEY_PEM [--installation PROJECT]');
    await importTLS(positionals[1], positionals[2], values.installation);
  } else if (command === 'up') {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { shared: { type: 'boolean' }, runtime: { type: 'string' }, installation: { type: 'string' }, 'network-plan': { type: 'string' } } });
    if (positionals.length) throw new Error('Usage: fogd up [--shared] [--runtime FAMILY [--network-plan FILE]] | --installation PROJECT');
    if (values.installation !== undefined) {
      if (!values.installation || values.runtime !== undefined || values.shared !== undefined || values['network-plan'] !== undefined) throw new Error('--installation requires only an enrolled project; omit --runtime, --shared and --network-plan');
      await upInstallation(values.installation);
    } else await up(values.shared === true, await startupOptions(values));
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
    if (args[0] === 'review') {
      await reviewCommand(args.slice(1));
    } else if (args[0] === 'recover') {
      if (args.length !== 7) throw new Error('Usage: fogd admin recover APP ID SHA RECOVERY_ID REVIEW_SHA --accept-possible-loss');
      await adminAcknowledgeRecovery(...args.slice(1));
    } else if (args[0] === 'repair') {
      if (args.length > 6) throw new Error('Too many repair arguments');
      await adminRepair(...args.slice(1));
    } else if (['delivery', 'dispatch'].includes(args[0])) {
      const maximum = args[0] === 'dispatch' && args[2] === 'recover' ? 8 : 5;
      if (args.length > maximum) throw new Error(`Too many ${args[0]} arguments`);
      await ({ delivery: adminDelivery, dispatch: adminDispatch })[args[0]](...args.slice(1));
    } else {
      if (args.length > 4) throw new Error('Too many admin arguments');
      await admin(...args);
    }
  }
  else if (!command || command === '--help' || command === 'help') {
    console.log('fogd admin review ID --output DIR  Export verified artifacts and compare a release');
    console.log('fogd client export DIR     Export a standalone developer CLI without images\nfogd client verify DIR --expected-manifest SHA');
    console.log('fogd observe APP --installation PROJECT  Observe native readiness locally\nfogd builds plan APP --output FILE  Review local build-copy retention\nfogd builds prune FILE --expected-plan SHA  Remove reviewed terminal copies\nfogd builds keep|unkeep APP BUILD_ID  Retain a local build explicitly\nfogd builds list APP        List local copies and unfinished pruning\nfogd builds resume APP BUILD_ID  Finish saved pruning without its plan file\nfogd runtime export DIR --runtime FAMILY  Export an offline runtime bundle\nfogd runtime verify DIR --runtime FAMILY --expected-manifest SHA\n                           Verify a trusted transfer without Docker\nfogd runtime import DIR --runtime FAMILY --expected-manifest SHA --output NEW\n                           Load images and install the matching operator CLI\nfogd docker render DIRECTORY --fleets 2|3  Write an unresolved Compose template\nfogd expand BUNDLE --fleets 3 --project NEW --output DIR\n                           Expand into a fresh stopped installation\nfogd retire BUNDLE --app NAME --digest SHA --project NEW --output DIR\n  [--stop-queued-work] [--stop-scheduled-work]\n  [--runtime FAMILY --expected-identity SHA256 [--network-plan FILE]]\n                           Retire into a fresh stopped Docker installation\nfogd kube render DIR --cert CERT --key KEY  Write experimental Kubernetes manifests\nfogd kube backup INSTALLATION BUNDLE --kubeconfig FILE --context NAME\nfogd kube restore BUNDLE --namespace NAME --output DIR --kubeconfig FILE --context NAME\nfogd backup DIRECTORY [--installation PROJECT]  Stop and snapshot\nfogd restore DIRECTORY --project NAME --output DIRECTORY\n  [--runtime FAMILY --expected-identity SHA256 [--network-plan FILE]]\n                           Restore onto fresh stopped volumes\nfogd tls import CERT KEY [--installation PROJECT]  Import while stopped\nfogd up [--shared] [--runtime FAMILY [--network-plan FILE]]  Start Docker\nfogd up --installation PROJECT  Start an enrolled installation without building\nfogd deploy [--name app]   Build and submit the current Void app for approval\nfogd status ID             Inspect a submission using its deploy credential\nfogd admin capacity        Inspect slot, pending, and artifact limits\nfogd admin inspect APP     Explain recorded app routing and activation state\nfogd admin delivery APP [status|observe|pause|resume ID SHA]  Control queue delivery\nfogd admin dispatch APP [status|observe|pause|resume ID SHA]  Control scheduled dispatch\nfogd admin dispatch APP recover ID SHA RECOVERY_ID REVIEW_SHA --accept-possible-loss\n                           Acknowledge scheduled-work recovery\nfogd admin recover APP ID SHA RECOVERY_ID REVIEW_SHA --accept-possible-loss  Acknowledge recovery\nfogd admin list            List submissions and secret revision names\nfogd admin issue-token NAME APP[,APP]  Issue a scoped deploy token once\nfogd admin revoke-token ID  Revoke a deploy credential\nfogd admin secrets APP     Replace secrets from JSON on stdin\nfogd admin approve ID SHA [REV]  Approve exact artifact and secret revision\nfogd admin repair NEW_ID NEW_SHA HELD_ID HELD_SHA [REV]  Approve a corrected artifact\nfogd admin reject ID SHA   Reject an artifact\n\nSet FOGD_HOME to the fogd checkout when using the CLI elsewhere.');
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(`fogd: ${error.message}`); process.exitCode = 1; }
