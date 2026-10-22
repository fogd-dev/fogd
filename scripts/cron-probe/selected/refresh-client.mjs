import assert from 'node:assert/strict';

export async function setRefreshSource(host, fixture, mode) {
  assert.ok(['healthy', 'retry-once', 'offline', 'lost-ack-once'].includes(mode));
  const response = await fixture.request('/api/refresh', { app: 'refresh', method: 'POST', headers: { Origin: `https://refresh.localhost:${host.gatewayPort}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
  assert.equal(response.status, 200); assert.deepEqual(response.json(), { mode });
  return response.json();
}
