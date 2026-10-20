CREATE TABLE cron_replacement_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hold_release TEXT NOT NULL DEFAULT 'old',
  inventory_position TEXT NOT NULL DEFAULT 'none' CHECK (inventory_position IN ('none','before','after')),
  position TEXT NOT NULL DEFAULT 'before' CHECK (position IN ('before','after')),
  armed_after INTEGER,
  held_time INTEGER,
  released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1))
);
INSERT INTO cron_replacement_control (id) VALUES (1);
CREATE TABLE cron_replacement_attempts (
  id TEXT PRIMARY KEY,
  release TEXT NOT NULL CHECK (release IN ('old', 'new', 'final')),
  job TEXT NOT NULL,
  cron TEXT NOT NULL,
  scheduled_time INTEGER,
  entered_at INTEGER NOT NULL,
  instance TEXT NOT NULL,
  held_at INTEGER,
  last_poll_at INTEGER,
  unblocked_at INTEGER,
  finished_at INTEGER,
  result_saved_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'success', 'thrown', 'rejected'))
);
CREATE INDEX cron_replacement_occurrence ON cron_replacement_attempts (cron, scheduled_time, job);
