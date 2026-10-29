import { runObservationHelper } from '../observe/helper.mjs';

export async function inspectInstallationTLS(installation, backing, run) {
  const tls = backing.volumes.find(volume => volume.role === 'tls');
  if (!tls) throw new Error('Installed TLS backing path is unavailable');
  const code = "import{loadTLS}from'./packages/runtime/src/transport.mjs';await loadTLS({FOGD_TLS:'1',FOGD_TLS_FILE:'/tls/keypair.json'});console.log(JSON.stringify({valid:true}));";
  const result = await runObservationHelper(installation, { purpose: 'doctor-tls',
    mount: `type=bind,src=${tls.mountpoint},dst=/tls,readonly`, code }, run);
  if (JSON.stringify(JSON.parse(result)) !== '{"valid":true}') throw new Error('TLS observation could not be decoded');
}
