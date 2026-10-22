import { verifyRuntimeHost } from '../runtime/catalog.mjs';

export async function verifyTransferHost() {
  const host = await verifyRuntimeHost();
  const containerdImageStore = (host.DriverStatus || []).some(([name, value]) => name === 'driver-type' && value === 'io.containerd.snapshotter.v1');
  if (host.Driver !== 'overlay2' || containerdImageStore) throw new Error('Offline transfer currently requires the qualified classic overlay2 Docker image store; other image stores need separate qualification. No daemon settings were changed.');
  return { driver: host.Driver, containerdImageStore };
}
