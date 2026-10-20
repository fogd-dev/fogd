import { sqliteTable, text, integer, primaryKey, check, foreignKey } from 'void/schema-d1';
import { sql } from 'void/db';
export const refreshSettings = sqliteTable('refresh_settings', { id: integer('id').primaryKey(), mode: text('mode').notNull() }, table => [
  check('single_setting', sql`${table.id} = 1`),
  check('known_mode', sql`${table.mode} IN ('healthy','retry-once','offline','lost-ack-once')`),
]);
export const refreshOccurrences = sqliteTable('refresh_occurrences', {
  job: text('job').notNull(), cron: text('cron').notNull(), scheduledTime: integer('scheduled_time').notNull(),
  initialMode: text('initial_mode').notNull(), status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(1), duplicates: integer('duplicates').notNull().default(0),
  lastAttemptAt: integer('last_attempt_at').notNull(), error: text('error'), completedAt: integer('completed_at'),
}, table => [primaryKey({ columns: [table.job, table.cron, table.scheduledTime] }),
  check('known_job', sql`${table.job} IN ('inventory','advisory')`),
  check('known_status', sql`${table.status} IN ('pending','failed','complete')`),
]);
export const refreshResults = sqliteTable('refresh_results', {
  job: text('job').notNull(), cron: text('cron').notNull(), scheduledTime: integer('scheduled_time').notNull(),
  value: text('value').notNull(), savedAt: integer('saved_at').notNull(),
}, table => [primaryKey({ columns: [table.job, table.cron, table.scheduledTime] }),
  foreignKey({ columns: [table.job, table.cron, table.scheduledTime], foreignColumns: [refreshOccurrences.job, refreshOccurrences.cron, refreshOccurrences.scheduledTime] }),
]);
