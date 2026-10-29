import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tlsEndpoint, inspectClientTrust } from '../src/doctor/tls-endpoint.mjs';
import { doctorOptions } from '../src/doctor/options.mjs';

const fingerprint = 'a'.repeat(64);

test('TLS endpoint accepts only explicit HTTPS origins, including bracketed IPv6', () => {
  assert.deepEqual(tlsEndpoint('https://localhost:8443'), { hostname: 'localhost', port: 8443 });
  assert.deepEqual(tlsEndpoint('https://[::1]'), { hostname: '::1', port: 443 });
  for (const value of ['http://localhost', 'https://u:private@localhost', 'https://localhost/path', 'https://localhost/?private=value', 'https://localhost/#private', 'https://localhost:0', 'private-invalid']) {
    assert.throws(() => tlsEndpoint(value), error => !error.message.includes('private'));
  }
});
test('TLS inspection flags require installation mode and an explicit server for online access', () => {
  const args = ['--installation', 'cloud', '--server', 'https://localhost', '--online'];
  assert.equal(doctorOptions(args, true).online, true);
  assert.throws(() => doctorOptions(args), /Unknown option/);
  for (const extra of [['--installation', 'cloud', '--online'], ['--runtime', 'family', '--server', 'https://localhost'], ['--project', 'app', '--name', 'demo', '--server', 'https://localhost']]) assert.throws(() => doctorOptions(extra, true), /Usage:/);
});

function connection(event, { code, authorized = true, observed = fingerprint } = {}) {
  const calls = [], socket = new EventEmitter(); let destroyed = 0;
  socket.authorized = authorized;
  socket.getPeerCertificate = () => ({ fingerprint256: observed.match(/../g).join(':').toUpperCase() });
  socket.destroy = () => { destroyed++; queueMicrotask(() => socket.emit('close')); };
  return { calls, destroyed: () => destroyed, dial: options => {
    calls.push(options); queueMicrotask(() => socket.emit(event, { code, message: 'private-error-detail' })); return socket;
  } };
}
test('trusted endpoint must match the installed fingerprint and sends no application request', async () => {
  const link = connection('secureConnect');
  const result = await inspectClientTrust({ hostname: 'localhost', port: 8443 }, fingerprint, link.dial);
  assert.equal(result.status, 'supported'); assert.equal(link.destroyed(), 1);
  assert.deepEqual(link.calls, [{ host: 'localhost', port: 8443, servername: 'localhost', rejectUnauthorized: true, minVersion: 'TLSv1.2' }]);
});
for (const options of [{ observed: 'b'.repeat(64) }, { authorized: false }]) test(`unverified peer cannot pass: ${JSON.stringify(options)}`, async () => {
  const link = connection('secureConnect', options);
  assert.equal((await inspectClientTrust({ hostname: '127.0.0.1', port: 443 }, fingerprint, link.dial)).status, 'unsupported');
  assert.equal(link.calls[0].servername, undefined);
});
for (const [code, status] of [['DEPTH_ZERO_SELF_SIGNED_CERT', 'unsupported'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'unsupported'], ['ECONNREFUSED', 'unverified'], ['private-error', 'unverified']]) {
  test(`TLS connection ${code} yields ${status} without private diagnostics`, async () => {
    const link = connection('error', { code }), result = await inspectClientTrust({ hostname: 'localhost', port: 443 }, fingerprint, link.dial);
    assert.equal(result.status, status); assert.ok(!JSON.stringify(result).includes('private-')); assert.equal(link.destroyed(), 1);
  });
}
