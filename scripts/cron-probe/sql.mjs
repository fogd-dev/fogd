export async function cronSQL(probe, artifact, sql) {
  const text = await probe.cli(['d1', 'execute', 'refresh-db', '--command', sql, artifact, '--json']);
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
