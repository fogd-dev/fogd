const check = (condition, message) => { if (!condition) throw new Error(message); };
const read = async response => ({ status: response.status, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer())) });
const recordURL = 'http://authority/routes.json';
async function phase(env, name) {
  const response = await env.CONTROL.fetch(`http://control/${name}`);
  check(response.status === 204, 'Host did not confirm the expected phase');
}
async function finish(env, value) {
  const response = await env.CONTROL.fetch('http://control/result', { method: 'POST', body: JSON.stringify(value) });
  check(response.status === 204, 'Host did not retain the result');
}
export default {
  async test(controller, env) {
    if (env.MODE === 'restart') {
      await phase(env, 'restart');
      const record = await read(await env.AUTHORITY.fetch(recordURL));
      check(record.value.revision === 3 && record.value.slot === 'slot-2', 'Restart lost the durable replacement');
      await finish(env, { record });
      return;
    }
    const missing = await env.AUTHORITY.fetch(recordURL);
    check(missing.status === 404, 'Missing record was not missing'); await missing.body?.cancel();
    await phase(env, 'missing');
    const active = await read(await env.AUTHORITY.fetch(recordURL));
    check(active.value.revision === 1 && active.value.state === 'active' && active.value.slot === 'slot-1', 'Initial record differs');
    const denied = await env.AUTHORITY.fetch(recordURL, { method: 'PUT', body: 'forbidden' });
    check(denied.status === 405, 'Read-only disk service did not refuse PUT'); await denied.body?.cancel();
    const held = await env.AUTHORITY.fetch(recordURL);
    await phase(env, 'held');
    const paused = await read(await env.AUTHORITY.fetch(recordURL));
    check(paused.value.revision === 2 && paused.value.state === 'paused', 'Fresh read retained stale active permission');
    const earlier = await read(held);
    check(earlier.value.revision === 1, 'Earlier read lost its complete old record');
    await phase(env, 'paused');
    const replacement = await read(await env.AUTHORITY.fetch(recordURL));
    check(replacement.value.revision === 3 && replacement.value.state === 'active' && replacement.value.slot === 'slot-2', 'Replacement not observed');
    await phase(env, 'replacement');
    const afterStop = await read(await env.AUTHORITY.fetch(recordURL));
    check(afterStop.value.revision === 3, 'Record unavailable after publisher stopped');
    await finish(env, { missingHTTPStatus: missing.status, putHTTPStatus: denied.status, active, paused, earlier, replacement, afterStop });
  }
};
