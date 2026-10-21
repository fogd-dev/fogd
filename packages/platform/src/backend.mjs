import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { bucketClient } from '@fogd/runtime/bucket';
import { QueueRuntime } from './queue-runtime.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class Backend {
  constructor(env = process.env) { this.env = Object.freeze({ ...env }); this.s3 = bucketClient(this.env); this.executable = '/usr/local/bin/celld';
    this.queues = new QueueRuntime({ run: (slot, args) => this.run(slot, args), inspect: node => this.deployment(node) });
  }
  async deployment(node) {
    const response = await fetch(`http://${node}:8081/state`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Runtime deployment inspection failed');
    return (await response.json()).deployment;
  }
  async owner(slot) {
    try {
      const object = await this.s3.send(new GetObjectCommand({ Bucket: this.env.FOGD_BUCKET, Key: `${slot.prefix}/fogd-owner.json` }));
      return JSON.parse(await object.Body.transformToString());
    } catch (error) { if (error.$metadata?.httpStatusCode === 404) return null; throw error; }
  }
  async claim(slot, app, { unpublished = false } = {}) {
    const current = await this.owner(slot);
    if (current && current.app !== app) throw new Error('Slot owner mismatch');
    if (current && !unpublished) return;
    if (await this.hasDeployment(slot)) throw new Error('Unresolved ownership claim contains a deployment; restore matching ownership metadata');
    if (current) return;
    try {
      await this.s3.send(new PutObjectCommand({ Bucket: this.env.FOGD_BUCKET, Key: `${slot.prefix}/fogd-owner.json`, Body: JSON.stringify({ app, assignedAt: new Date().toISOString() }), IfNoneMatch: '*' }));
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 412) throw error;
      if ((await this.owner(slot))?.app !== app) throw new Error('Slot owner mismatch');
    }
  }
  async hasDeployment(slot) {
    const result = await this.s3.send(new ListObjectsV2Command({ Bucket: this.env.FOGD_BUCKET, Prefix: `${slot.prefix}/deploy/`, MaxKeys: 1 }));
    return Boolean(result.KeyCount);
  }
  async assertUnclaimed(slot) {
    if (await this.owner(slot)) throw new Error('Fleet ownership exists; retry the original claim before rejection');
    if (await this.hasDeployment(slot)) throw new Error('Fleet contains deployment objects; restore matching ownership metadata');
  }
  run(slot, args) {
    return new Promise((resolve, reject) => {
      let output = '', errors = '';
      const child = spawn(this.executable, args, { env: { ...this.env, CELLD_BUCKET: `s3://${this.env.FOGD_BUCKET}/${slot.prefix}` }, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
      child.stdout.on('data', data => { output = (output + data).slice(-1024 * 1024); });
      child.stderr.on('data', data => { errors = (errors + data).slice(-16000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`celld ${args[0]} failed (${code}): ${errors.slice(-3000)}`)); });
    });
  }
  async publish(slot, dir) {
    const output = await this.run(slot, ['deploy', dir, '--json']);
    const data = JSON.parse(output.trim().split('\n').at(-1));
    if (typeof data.version !== 'string') throw new Error('Missing deployment version');
    return data.version;
  }
  async bootstrap(slot, artifact, resources) {
    if (Object.hasOwn(resources, 'crons')) {
      if (typeof this.crons?.preflightBootstrap !== 'function') {
        const error = new Error('Cron bootstrap requires runtime identity verification');
        error.code = 'CRON_RUNTIME_UNVERIFIED'; throw error;
      }
      await this.crons.preflightBootstrap(slot);
    }
    const source = JSON.parse(await readFile(join(artifact, 'wrangler.json'), 'utf8'));
    const dir = await mkdtemp(join(tmpdir(), 'fogd-bootstrap-'));
    try {
      const config = { name: resources.script, main: 'index.js', no_bundle: true,
        ...(source.compatibility_date ? { compatibility_date: source.compatibility_date } : {}),
        d1_databases: resources.d1,
        ...(resources.queues ? { queues: { producers: resources.queues.producers } } : {}) };
      await writeFile(join(dir, 'wrangler.json'), JSON.stringify(config), { mode: 0o600 });
      await writeFile(join(dir, 'index.js'), "export default {fetch(){return new Response('Bootstrap',{status:503})}};\n", { mode: 0o600 });
      return await this.publish(slot, dir);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async ready(slot, version) {
    const deadline = Date.now() + 180000;
    for (const node of slot.nodes) {
      let last = new Error('Replica readiness deadline exceeded');
      while (Date.now() < deadline) {
        try {
          const reload = await fetch(`http://${node}:8081/reload`, { method: 'POST', signal: AbortSignal.timeout(5000) });
          if (!reload.ok || (await reload.json()).version !== version) throw new Error('Version not adopted');
          const health = await fetch(`http://${node}:8080/.well-known/celld/health`, { signal: AbortSignal.timeout(3000) });
          await health.body?.cancel();
          if (!health.ok) throw new Error('Replica unhealthy');
          last = null; break;
        } catch (error) { last = error; await sleep(1000); }
      }
      if (last) throw new Error(`${node}: ${last.message}`);
    }
  }
  async applicationReady(slot) {
    for (const node of slot.nodes) {
      const response = await fetch(`http://${node}:8080/__void/ready`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok || (await response.json()).ready !== true) throw new Error('Void application environment validation failed');
    }
  }
  async migrate(slot, dir, resources) {
    for (const db of resources.d1) await this.run(slot, ['d1', 'migrations', 'apply', db.database_name, dir]);
  }
  async applied(slot, dir, resources) {
    const result = [];
    for (const db of resources.d1) {
      const sql = 'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP); SELECT name FROM d1_migrations;';
      const output = await this.run(slot, ['d1', 'execute', db.database_name, '--command', sql, dir, '--json']);
      for (const line of output.trim().split('\n').filter(Boolean)) {
        const row = JSON.parse(line);
        if (row.name) result.push({ database: db.database_id, name: row.name });
      }
    }
    return result;
  }
}
