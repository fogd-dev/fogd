import { inspectHost } from './host.mjs';
import { doctorOptions } from './options.mjs';
import { diagnoseApplication } from './application-command.mjs';
import { printReport } from './report.mjs';
import { diagnoseInstalledApplication } from './installed-application.mjs';
import { inspectInstallation } from './installation.mjs';

export { formatReport as formatHostReport } from './report.mjs';

export async function doctorCommand(args) {
  const values = doctorOptions(args, true);
  const report = values['against-installation'] ? await diagnoseInstalledApplication(values) : values.installation ? await inspectInstallation(values.installation)
    : values.runtime ? await inspectHost(values.runtime) : await diagnoseApplication(values);
  printReport(report, values.json);
}
