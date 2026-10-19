// Runtime-only qualification fixture; it is not an admitted fogd application.
const version = 'PROBE_VERSION';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function event(env, message, stage) {
  const value = { job: message.body.id, version, attempt: message.attempts, stage, at: Date.now() };
  await env.RESULTS.put(`events/${value.job}/${value.attempt}/${version}/${stage}`, JSON.stringify(value));
}
export default {
  async fetch(request, env) {
    if (request.method === 'POST') {
      const body = await request.json();
      await env.JOBS.send(body);
      return Response.json({ queued: body.id });
    }
    const list = await env.RESULTS.list({ prefix: 'events/' });
    return Response.json(await Promise.all(list.objects.map(async object => (await env.RESULTS.get(object.key)).json())));
  },
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      await event(env, message, 'started');
      if (message.body.waitUntilMs) ctx.waitUntil(wait(message.body.waitUntilMs).then(() => event(env, message, 'wait-until')));
      if (message.body.holdMs) await wait(message.body.holdMs);
      if (message.body.fail) { await event(env, message, 'failed'); throw new Error('Deliberate probe failure'); }
      await event(env, message, 'completed');
    }
  },
};
