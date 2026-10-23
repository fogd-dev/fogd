import { server } from './http.mjs';
import { routingStartupError } from './controller-routes.mjs';

async function initialize(controller) {
  try { await controller.init(); }
  catch (error) {
    if (error.code !== 'ROUTE_STARTUP_UNRECONCILED' || !controller.routingRecoveryAvailable) throw error;
    controller.assertStorage(); return true;
  }
  if (!controller.routes.durable || controller.routingStartupComplete) return false;
  if (!controller.routingRecoveryAvailable) throw routingStartupError();
  controller.assertStorage(); return true;
}
function listen(http, port, host) {
  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => { http.off('error', reject); resolve(); });
  });
}
function close(http, force = false) {
  if (!http?.listening) return Promise.resolve();
  return new Promise(resolve => { http.close(resolve); if (force) http.closeAllConnections(); });
}
// Recovery restriction lasts for this service's lifetime. A launch coordinator
// must perform pre-ingress checks and restart normally after explicit repair.
export async function serveController(controller, credentials, { tls = null, maxUploads = 2, host = '0.0.0.0', port = 8082, internalPort = 8083 } = {}) {
  const recoveryOnly = await initialize(controller);
  const http = server(controller, credentials, { tls, maxUploads, recoveryOnly });
  const internal = controller.routes.durable ? null : server(controller, credentials, { role: 'internal' });
  try {
    await listen(http, port, host);
    if (internal) await listen(internal, internalPort, host);
  } catch (error) { await Promise.all([close(http, true), close(internal, true)]); throw error; }
  return { controller, http, internal, recoveryOnly, close: ({ force = false } = {}) => Promise.all([close(http, force), close(internal, force)]) };
}
