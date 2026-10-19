export function resultWrites(db, id, rows) {
  return rows.map((label, position) => db.prepare('INSERT INTO import_results (job_id, position, label) VALUES (?, ?, ?) ON CONFLICT(job_id, position) DO NOTHING').bind(id, position, label.toUpperCase()));
}
