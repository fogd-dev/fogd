import { parseArgs } from 'node:util';
import { render } from './render.mjs';
import { kubeBackup } from './recovery/backup.mjs';
import { kubeRestore } from './recovery/restore.mjs';

export async function kubernetesCommand(args) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(['cert', 'key', 'kubeconfig', 'context', 'namespace', 'output'].map(key => [key, { type: 'string' }])) });
  const [action, first, second] = positionals;
  const contracts = { render: { count: 2, keys: ['cert', 'key'] }, backup: { count: 3, keys: ['kubeconfig', 'context'] }, restore: { count: 2, keys: ['namespace', 'output', 'kubeconfig', 'context'] } };
  const contract = contracts[action];
  if (!contract || positionals.length !== contract.count || contract.keys.some(key => !values[key]) || Object.keys(values).some(key => !contract.keys.includes(key))) throw new Error('Usage: fogd kube render DIR --cert CERT --key KEY; kube backup INSTALLATION BUNDLE --kubeconfig FILE --context NAME; kube restore BUNDLE --namespace NAME --output DIR --kubeconfig FILE --context NAME');
  if (action === 'render') return render(first, values.cert, values.key);
  if (action === 'backup') return kubeBackup(first, second, values.kubeconfig, values.context);
  return kubeRestore(first, values.namespace, values.output, values.kubeconfig, values.context);
}
