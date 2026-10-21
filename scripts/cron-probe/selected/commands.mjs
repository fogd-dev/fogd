import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function commandRunner(output, environment) {
  return (command, args, { env = environment, cwd, inputText, timeout = 240000 } = {}) => new Promise((resolve, reject) => {
    const child = execFile(command, args, { env, cwd, timeout, maxBuffer: 64 * 1024 * 1024 }, async (error, stdout, stderr) => {
      if (!error) { resolve(stdout); return; }
      try {
        const file = `command-failure-${randomUUID()}.json`;
        await writeFile(join(output, file), JSON.stringify({ code: error.code, signal: error.signal, stdout, stderr }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        const failure = new Error(`Qualification command failed; inspect private ${file}`);
        failure.diagnosticFile = join(output, file); reject(failure);
      } catch { reject(new Error('Qualification command failed and its private diagnostic could not be recorded')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(inputText);
  });
}
export function commandJson(text) {
  const start = text.lastIndexOf('\n{');
  return JSON.parse(text.slice(start < 0 ? 0 : start + 1).trim());
}
