// Intentionally empty by default.
// Add Drizzle tables here when the site actually needs a database.
// See examples/d1/db/schema.ts for an opt-in example.
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const notebookWorkspaces = sqliteTable('notebook_workspaces', {
  id: text('id').primaryKey(), body: text('body').notNull(),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
  lease: text('lease'), leaseUntil: integer('lease_until').notNull().default(0),
  writeDay: text('write_day').notNull(), writes: integer('writes').notNull().default(0),
});
