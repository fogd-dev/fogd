import { spawn } from 'node:child_process';
import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { bucketClient } from '@fogd/runtime/bucket';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class Backend {
  constructor(env = process.env) { this.env = env; this.s3 = bucketClient(env); }
  async owner(slot) {
    try {
      const object = await this.s3.send(new GetObjectCommand({ Bucket: this.env.FOGD_BUCKET, Key: `${slot.prefix}/fogd-owner.json` }));
      return JSON.parse(await object.Body.transformToString());
    } catch (error) { if (error.$metadata?.httpStatusCode === 404) return null; throw error; }
  }
  async claim(slot, app) {
    const current = await this.owner(slot);
    if (current) { if (current.app !== app) throw new Error('Slot owner mismatch'); return; }
    const old = await this.s3.send(new ListObjectsV2Command({ Bucket: this.env.FOGD_BUCKET, Prefix: `${slot.prefix}/deploy/`, MaxKeys: 1 }));
    if (old.KeyCount) throw new Error('Unowned slot contains a deployment; restore its ownership metadata');
    try {
      await this.s3.send(new PutObjectCommand({ Bucket: this.env.FOGD_BUCKET, Key: `${slot.prefix}/fogd-owner.json`, Body: JSON.stringify({ app, assignedAt: new Date().toISOString() }), IfNoneMatch: '*' }));
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 412) throw error;
      if ((await this.owner(slot))?.app !== app) throw new Error('Slot owner mismatch');
    }
  }
  run(slot, args) {
    return new Promise((resolve, reject) => {
      let output = '', errors = '';
      const child = spawn('celld', args, { env: { ...this.env, CELLD_BUCKET: `s3://${this.env.FOGD_BUCKET}/${slot.prefix}` }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  async ready(slot, version) {
    for (const node of slot.nodes) {
      let last;
      for (let attempt = 0; attempt < 120; attempt++) {
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
