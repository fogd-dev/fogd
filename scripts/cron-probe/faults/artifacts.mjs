import { prepareReleaseArtifacts } from '../release/artifacts.mjs';
import { faultProject } from './build.mjs';
import contract from './contract.mjs';

export function prepareFailures(output) {
  return prepareReleaseArtifacts(output, contract, { fast: '* * * * *', sparse: '*/3 * * * *' }, (directory, name, cron) => faultProject(directory, cron));
}
