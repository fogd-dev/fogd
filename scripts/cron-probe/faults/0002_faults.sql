CREATE TABLE cron_fault_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  policy TEXT NOT NULL CHECK (policy IN ('healthy','no-retry','owner-loss','terminal')),
  phase TEXT NOT NULL
);
INSERT INTO cron_fault_control VALUES (1, 'healthy', 'startup');
CREATE TABLE cron_fault_attempts (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL,
  cron TEXT NOT NULL,
  scheduled_time INTEGER,
  entered_at INTEGER NOT NULL,
  finished_at INTEGER,
  instance TEXT NOT NULL,
  phase TEXT NOT NULL,
  policy TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','success','thrown','rejected')),
  no_retry_called INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX cron_fault_occurrence ON cron_fault_attempts (phase, job, cron, scheduled_time);
