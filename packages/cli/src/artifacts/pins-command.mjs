import { mutateArtifact, uncertainArtifactMutation } from './mutation.mjs';
const uncertain = () => uncertainArtifactMutation('pin');

function parse(args) {
  const [action, id, digest] = args;
  if (args.length !== 3 || !['keep', 'unkeep'].includes(action)) throw new Error('Usage: fogd admin artifacts keep|unkeep ID SHA');
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Artifact pin changes require a canonical deployment ID and SHA256 digest');
  return { action, id, digest };
}

export async function artifactPinCommand(args) {
  const command = parse(args);
  const value = await mutateArtifact('pin', `/v1/admin/artifacts/${command.id}/${command.action}`, { digest: command.digest });
  if (value?.schema !== 1 || value.id !== command.id || value.digest !== command.digest || value.kept !== (command.action === 'keep')) throw uncertain();
  console.log(JSON.stringify({ schema: 1, id: value.id, digest: value.digest, kept: value.kept }, null, 2));
}
