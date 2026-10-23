import { mutateArtifact, uncertainArtifactMutation } from './mutation.mjs';
import { artifactPruneReceipt } from './prune-view.mjs';

export async function artifactPruneCommand(args) {
  const [action, identity] = args;
  if (args.length !== 2 || !['prune', 'resume'].includes(action)) throw new Error('Usage: fogd admin artifacts prune PLAN_SHA | resume OPERATION_ID');
  const valid = action === 'prune' ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  if (!valid.test(identity)) throw new Error('Artifact pruning requires the reviewed plan digest or canonical operation ID');
  const path = action === 'prune' ? '/v1/admin/artifacts/prune' : `/v1/admin/artifacts/prune/${identity}/resume`;
  const value = await mutateArtifact('prune', path, action === 'prune' ? { plan: identity } : {});
  let receipt;
  try { receipt = artifactPruneReceipt(value); } catch { throw uncertainArtifactMutation('prune'); }
  if ((action === 'prune' ? receipt.plan : receipt.id) !== identity) throw uncertainArtifactMutation('prune');
  console.log(JSON.stringify(receipt, null, 2));
}
