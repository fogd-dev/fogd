import { sqliteTable, text } from 'void/schema-d1';
export const entries = sqliteTable('entries', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
});
