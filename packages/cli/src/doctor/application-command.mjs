import { configEnv } from '../local.mjs';
import { controllerOrigin } from '../build-cache/paths.mjs';
import { deployCapabilities } from '../deploy-capabilities.mjs';
import { inspectApplicationFile } from './application.mjs';
import { doctorOptions } from './options.mjs';
import { printReport } from './report.mjs';

export async function diagnoseApplication(values) {
  return inspectApplicationFile(values.config, values.name, values.online ? async app => {
    const env = await configEnv();
    if (!env.FOGD_SERVER || !env.FOGD_DEPLOY_TOKEN) throw new Error('Controller endpoint and scoped deploy token are required');
    return deployCapabilities(controllerOrigin(env.FOGD_SERVER), env.FOGD_DEPLOY_TOKEN, app);
  } : undefined);
}

export async function applicationDoctorCommand(args) {
  const values = doctorOptions(args);
  printReport(await diagnoseApplication(values), values.json);
}
