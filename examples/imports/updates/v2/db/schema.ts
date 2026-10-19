import { sqliteTable, text, integer, primaryKey } from 'void/schema-d1';
export const importJobs = sqliteTable('import_jobs', {
  id: text('id').primaryKey(), inputHash: text('input_hash').notNull(),
  mode: text('mode').notNull(), delayMs: integer('delay_ms').notNull().default(0),
  status: text('status').notNull().default('accepted'), attempts: integer('attempts').notNull().default(0),
  error: text('error'), createdAt: text('created_at').notNull(),
});
export const importResults = sqliteTable('import_results', {
  jobId: text('job_id').notNull().references(() => importJobs.id),
  position: integer('position').notNull(), label: text('label').notNull(), processor: text('processor').notNull().default('v1'),
}, table => [primaryKey({ columns: [table.jobId, table.position] })]);
