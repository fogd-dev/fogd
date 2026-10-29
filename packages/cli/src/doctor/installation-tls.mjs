import { runObservationHelper } from '../observe/helper.mjs';

export async function inspectInstallationTLS(installation, backing, run, hostname) {
  const tls = backing.volumes.find(volume => volume.role === 'tls');
  if (!tls) throw new Error('Installed TLS backing path is unavailable');
  let code = "import{loadTLS}from'./packages/runtime/src/transport.mjs';await loadTLS({FOGD_TLS:'1',FOGD_TLS_FILE:'/tls/keypair.json'});console.log(JSON.stringify({valid:true}));";
  if (hostname) code = "import{loadTLS}from'./packages/runtime/src/transport.mjs';import{X509Certificate}from'node:crypto';import{checkServerIdentity}from'node:tls';const chunks=[];for await(const c of process.stdin)chunks.push(c);const hostname=JSON.parse(Buffer.concat(chunks));const pair=await loadTLS({FOGD_TLS:'1',FOGD_TLS_FILE:'/tls/keypair.json'}),cert=new X509Certificate(pair.cert);console.log(JSON.stringify({valid:true,hostnameMatches:checkServerIdentity(hostname,cert.toLegacyObject())===undefined,fingerprint:cert.fingerprint256.replaceAll(':','').toLowerCase()}));";
  const result = await runObservationHelper(installation, { purpose: 'doctor-tls',
    mount: `type=bind,src=${tls.mountpoint},dst=/tls,readonly`, code, ...(hostname ? { inputText: JSON.stringify(hostname) } : {}) }, run);
  const observation = JSON.parse(result);
  const valid = hostname ? observation?.valid === true && typeof observation.hostnameMatches === 'boolean' && /^[a-f0-9]{64}$/.test(observation.fingerprint) && Object.keys(observation).length === 3 : JSON.stringify(observation) === '{"valid":true}';
  if (!valid) throw new Error('TLS observation could not be decoded');
  return observation;
}
