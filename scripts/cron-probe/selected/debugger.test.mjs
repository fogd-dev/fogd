import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SourceDebugger } from './source-debugger.mjs';
import { DebuggerTransport } from './debugger-transport.mjs';
import { controllerProcess } from './controller-debugger.mjs';
import { restartInterruptedController } from './controller-restart.mjs';
import { runtimeFamily } from '../../../packages/cli/src/runtime/catalog.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const path = 'packages/platform/src/backend.mjs';
const source = 'export class Example {\n  async migrate() {\n    return true;\n  }\n}\n';
const digest = createHash('sha256').update(source).digest('hex');
const location = { scriptId: 'backend', lineNumber: 2, columnNumber: 4 };
function fixture({ text = source, frame = {}, duplicates = false, moved = false, hitBreakpoints = ['expected'] } = {}) {
  const commands = [], state = { paused: true, sequence: 3 };
  const transport = {
    pauseState: state,
    async request(method, params) {
      commands.push({ method, params });
      if (method === 'Debugger.getScriptSource') return { scriptSource: text };
      if (method === 'Debugger.getPossibleBreakpoints') return { locations: [location] };
      if (method === 'Debugger.setBreakpoint') return { breakpointId: 'expected', actualLocation: { ...location, ...(moved ? { lineNumber: 3 } : {}) } };
      return {};
    },
    async event(method) {
      if (method === 'Debugger.scriptParsed') return { scriptId: 'backend', url: 'file:///app/' + path };
      return { reason: 'other', hitBreakpoints, callFrames: [{ functionName: 'migrate', location, ...frame }] };
    },
    takeEvents: () => duplicates ? [{ method: 'Debugger.scriptParsed' }] : [],
    close: async () => {},
  };
  return { session: new SourceDebugger(transport, { [path]: digest }), commands, state };
}
const selected = { path, marker: 'return true;', functionName: 'migrate' };

function restartFixture() {
  const identity = { container: 'c'.repeat(64), image: 'sha256:' + 'a'.repeat(64), project: 'owned', startedAt: '2026-10-29T10:00:00Z' };
  const before = { Id: identity.container, Image: identity.image, Config: { Labels: { 'com.docker.compose.project': 'owned', 'com.docker.compose.service': 'controller' } },
    HostConfig: { ReadonlyRootfs: true }, RestartCount: 0, State: { Running: false, Restarting: false, StartedAt: identity.startedAt, ExitCode: 137, OOMKilled: false } };
  const after = structuredClone(before); Object.assign(after.State, { Running: true, StartedAt: '2026-10-29T10:01:00Z', ExitCode: 0 });
  const calls = []; let inspections = 0;
  const run = async args => { calls.push(args); return args[0] === 'inspect' ? JSON.stringify([++inspections === 1 ? before : after]) : ''; };
  return { identity, before, after, calls, run };
}

test('interrupted controller restart touches only the verified retained controller and records its new process', async () => {
  const f = restartFixture(), restarted = await restartInterruptedController(f.identity, f.run);
  assert.deepEqual(f.calls, [['inspect', f.identity.container], ['start', f.identity.container], ['inspect', f.identity.container]]);
  assert.equal(restarted.previousExitCode, 137); assert.equal(restarted.startedAt, f.after.State.StartedAt);
  assert.equal(restarted.previousStartedAt, f.identity.startedAt); assert.equal(restarted.unchangedConfiguration, true);
});

for (const [name, alter] of [
  ['wrong project', f => { f.before.Config.Labels['com.docker.compose.project'] = 'other'; }],
  ['wrong image', f => { f.before.Image = 'sha256:' + 'b'.repeat(64); }],
  ['another process', f => { f.before.State.StartedAt = '2026-10-29T09:59:00Z'; }],
  ['running controller', f => { f.before.State.Running = true; }],
  ['unconfirmed kill', f => { f.before.State.ExitCode = 0; }],
]) test(`controller restart refuses ${name} before starting anything`, async () => {
  const f = restartFixture(); alter(f);
  await assert.rejects(restartInterruptedController(f.identity, f.run), { code: 'ERR_ASSERTION' });
  assert.deepEqual(f.calls, [['inspect', f.identity.container]]);
});

for (const [name, alter] of [
  ['replaced container', f => { f.after.Id = 'd'.repeat(64); }],
  ['changed configuration', f => { f.after.Config.Cmd = ['different']; }],
  ['unchanged process', f => { f.after.State.StartedAt = f.before.State.StartedAt; }],
]) test(`controller restart does not accept ${name} as success`, async () => {
  const f = restartFixture(); alter(f); await assert.rejects(restartInterruptedController(f.identity, f.run), { code: 'ERR_ASSERTION' });
});

for (const [family, main] of [
  ['celld-cron-v2-linux-arm64', 'packages/platform/src/main.mjs'],
  ['celld-durable-v3-linux-arm64', 'packages/platform/src/main-durable.mjs'],
]) test(`controller checkpoint identity binds the catalog launch for ${family}`, async () => {
  const entry = runtimeFamily(family, 'enrolled'), container = 'c'.repeat(64), calls = [];
  const actual = { Id: container, Image: entry.image, State: { Running: true, StartedAt: 'start' }, HostConfig: { ReadonlyRootfs: true },
    Config: { Labels: { 'com.docker.compose.project': 'owned', 'com.docker.compose.service': 'controller' }, Entrypoint: ['/usr/local/bin/node'], Cmd: [main] } };
  const run = async args => { calls.push(args); return JSON.stringify(args[0] === 'inspect' ? [actual] : { processStart: '123' }); };
  const identity = await controllerProcess(container, 'owned', family, run);
  assert.deepEqual(identity, { container, project: 'owned', family, image: entry.image, startedAt: 'start', processStart: '123' });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].at(-1).includes(JSON.stringify(['/usr/local/bin/node', main])));
  actual.Config.Cmd = [main === 'packages/platform/src/main.mjs' ? 'packages/platform/src/main-durable.mjs' : 'packages/platform/src/main.mjs'];
  await assert.rejects(controllerProcess(container, 'owned', family, run), /identity or launch/);
  assert.equal(calls.length, 3, 'wrong launch refuses before process inspection');
});

test('source-verified checkpoints bind the expected executable line and paused function', async () => {
  const f = fixture(), checkpoint = await f.session.breakpoint(selected), paused = await f.session.paused(checkpoint);
  assert.deepEqual(checkpoint.location, location); assert.equal(checkpoint.sha256, digest);
  assert.equal(paused.frame.functionName, 'migrate'); assert.equal(paused.pauseSequence, 3);
});

test('different loaded source refuses before installing a breakpoint', async () => {
  const f = fixture({ text: source.replace('return true', 'return false') });
  await assert.rejects(f.session.breakpoint(selected), /Loaded debugger source differs/);
  assert.equal(f.commands.some(c => c.method === 'Debugger.setBreakpoint'), false);
});

test('unknown source and conditions that can change product state refuse before any command', async () => {
  const f = fixture();
  await assert.rejects(f.session.breakpoint({ ...selected, path: 'unknown.mjs' }), /outside the checked inventory/);
  await assert.rejects(f.session.breakpoint({ ...selected, condition: 'globalThis.enabled = true' }), /Unsupported immutable checkpoint/);
  assert.deepEqual(f.commands, []);
});

test('duplicate loaded URLs and moved executable locations cannot qualify a checkpoint', async () => {
  await assert.rejects(fixture({ duplicates: true }).session.breakpoint(selected), /loaded more than once/);
  await assert.rejects(fixture({ moved: true }).session.breakpoint(selected), /moved the requested checkpoint/);
});

test('ambiguous source markers cannot choose a checkpoint silently', async () => {
  const f = fixture();
  await assert.rejects(f.session.breakpoint({ ...selected, marker: '}' }), /uniquely identifies/);
  assert.equal(f.commands.some(c => c.method === 'Debugger.setBreakpoint'), false);
});

test('a different paused function or location fails rather than accepting an earlier event', async () => {
  for (const frame of [{ functionName: 'other' }, { location: { ...location, columnNumber: 9 } }]) {
    const f = fixture({ frame }), checkpoint = await f.session.breakpoint(selected);
    await assert.rejects(f.session.paused(checkpoint), /outside its expected checkpoint/);
  }
});

test('a resumed or changed pause sequence invalidates the saved checkpoint', () => {
  const f = fixture(); assert.equal(f.session.assertPaused(), 3);
  f.state.paused = false; assert.throws(() => f.session.assertPaused(3), /advanced beyond/);
  f.state.paused = true; f.state.sequence = 5;
  assert.throws(() => f.session.assertPaused(3), /advanced beyond/);
});

test('a matching frame without the selected breakpoint cannot qualify a pause', async () => {
  const f = fixture({ hitBreakpoints: ['different'] }), checkpoint = await f.session.breakpoint(selected);
  await assert.rejects(f.session.paused(checkpoint), /outside its expected checkpoint/);
});

const bridge = `import{createInterface}from'node:readline';
const mode=process.argv.at(-1),emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
emit({type:'ready',processStart:'123'});
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 const message=JSON.parse(line);
 if(mode==='exit')process.exit(23);
 if(mode==='silent')continue;
 if(mode==='malformed'){process.stdout.write('not-json\\n');continue;}
 emit({type:'message',value:{id:mode==='unknown'?message.id+1:message.id,result:{}}});
 if(message.method==='Debugger.enable')emit({type:'message',value:{method:'Debugger.paused',params:{reason:'other'}}});
 if(message.method==='Debugger.resume')emit({type:'message',value:{method:'Debugger.resumed',params:{}}});
}`;

async function withBridge(mode, run) {
  const directory = await mkdtemp(join(tmpdir(), 'fogd-debugger-transport-')), originalPath = process.env.PATH;
  let transport;
  try {
    await writeFile(join(directory, 'docker'), `#!${process.execPath}\n${bridge}`, { mode: 0o700 });
    process.env.PATH = `${directory}:${originalPath}`;
    transport = new DebuggerTransport('owned-test-container', mode);
    assert.equal((await transport.ready()).processStart, '123');
    await run(transport);
  } finally {
    process.env.PATH = originalPath;
    try { if (transport) await transport.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

test('the real transport tracks pause and resume events from a separate bridge process', async () => {
  await withBridge('normal', async transport => {
    await transport.request('Debugger.enable'); await transport.event('Debugger.paused');
    assert.deepEqual(transport.pauseState, { paused: true, sequence: 1 });
    await transport.request('Debugger.resume'); await transport.event('Debugger.resumed');
    assert.deepEqual(transport.pauseState, { paused: false, sequence: 2 });
  });
});

test('malformed output, wrong reply identity and bridge exit invalidate all pending commands', async () => {
  for (const mode of ['malformed', 'unknown', 'exit']) await withBridge(mode, async transport => {
    await assert.rejects(transport.request('Runtime.enable'), /Invalid or excessive debugger output|Debugger helper exited/);
    assert.throws(() => transport.pauseState, /Invalid or excessive debugger output|Debugger helper exited/);
  });
});

test('a command timeout permanently invalidates a bridge rather than accepting a later observation', async () => {
  await withBridge('silent', async transport => {
    await assert.rejects(transport.request('Runtime.enable', {}, 30), /Debugger command timed out/);
    await assert.rejects(transport.request('Debugger.enable'), /Debugger command timed out/);
    assert.throws(() => transport.pauseState, /Debugger command timed out/);
  });
});
