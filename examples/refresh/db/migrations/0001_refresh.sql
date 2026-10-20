CREATE TABLE refresh_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('healthy', 'retry-once', 'offline', 'lost-ack-once'))
);
INSERT INTO refresh_settings VALUES (1, 'retry-once');
CREATE TABLE refresh_occurrences (
  job TEXT NOT NULL CHECK (job IN ('inventory', 'advisory')),
  cron TEXT NOT NULL,
  scheduled_time INTEGER NOT NULL,
  initial_mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed', 'complete')),
  attempts INTEGER NOT NULL DEFAULT 1,
  duplicates INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL,
  error TEXT,
  completed_at INTEGER,
  PRIMARY KEY (job, cron, scheduled_time)
);
CREATE TABLE refresh_results (
  job TEXT NOT NULL,
  cron TEXT NOT NULL,
  scheduled_time INTEGER NOT NULL,
  value TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (job, cron, scheduled_time),
  FOREIGN KEY (job, cron, scheduled_time) REFERENCES refresh_occurrences(job, cron, scheduled_time)
);
