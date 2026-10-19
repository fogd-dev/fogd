CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  mode TEXT NOT NULL,
  delay_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'accepted',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE import_results (
  job_id TEXT NOT NULL REFERENCES import_jobs(id),
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (job_id, position)
);
