import { connect } from 'node:tls';
import { isIP } from 'node:net';
import { finding } from './report.mjs';

export function tlsEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Doctor TLS endpoint must be an HTTPS origin'); }
  if (value.length > 2048 || url.hostname.length > 255 || url.port === '0' || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Doctor TLS endpoint must be an HTTPS origin without credentials, path, query or fragment');
  return { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443) };
}

export async function inspectClientTrust(endpoint, fingerprint, dial = connect) {
  const result = await new Promise(resolve => {
    let outcome = 'unverified', socket, deadline, finished = false;
    const finish = value => { if (finished) return; finished = true; outcome = value; socket.destroy(); };
    try {
      socket = dial({ host: endpoint.hostname, port: endpoint.port, ...(isIP(endpoint.hostname) ? {} : { servername: endpoint.hostname }),
        rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    } catch { resolve('unverified'); return; }
    deadline = setTimeout(() => finish('unverified'), 5000);
    socket.once('secureConnect', () => {
      const observed = socket.getPeerCertificate().fingerprint256?.replaceAll(':', '').toLowerCase();
      finish(socket.authorized && observed === fingerprint ? 'supported' : 'unsupported');
    });
    socket.once('error', error => {
      const refused = ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID'];
      finish(refused.includes(error.code) ? 'unsupported' : 'unverified');
    });
    socket.once('close', () => { clearTimeout(deadline); resolve(outcome); });
  });
  return finding('tls-client-trust', result,
    result === 'supported' ? 'The current Node client verified the endpoint hostname and certificate chain, and its leaf fingerprint matches the installed certificate.' :
      result === 'unsupported' ? 'The current client refused certificate verification or observed a different endpoint certificate.' : 'The endpoint TLS handshake could not be verified.',
    'Check the selected endpoint and current Node CA settings; set NODE_EXTRA_CA_CERTS before launching Node when needed. This TLS-only check sends no HTTP or credentials and does not establish application health or revocation status.');
}
