import { prepareReleaseArtifacts } from '../release/artifacts.mjs';
import { replacementProject } from './build.mjs';
import contract from './contract.mjs';

export function prepareReplacement(output) {
  return prepareReleaseArtifacts(output, contract, { old: '* * * * *', new: '* * * * *', final: '* * * * *' }, replacementProject);
}
