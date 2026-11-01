import { z } from 'zod';
import { SESSION_STATUSES } from './constants.js';
import { boundedStringSchema, canonicalIdSchema, nameSchema, unixMsSchema } from './validation.js';

export const DIRECTORY_PAGE_LIMIT = 64;
export const DIRECTORY_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
export const directoryViewSchema = z.enum(['tasks', 'repos', 'search']);
export const directoryListParamsSchema = z.strictObject({
  view: directoryViewSchema,
  query: z.string().trim().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(DIRECTORY_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).max(4096).optional(),
}).refine(value => (value.view === 'search') === (value.query !== undefined),
  'query is required only for the search view');

/** Directory rows are bounded summaries, never truncated transcripts/queues. */
export const remoteDirectoryEntrySchema = z.strictObject({
  id: canonicalIdSchema,
  revision: boundedStringSchema,
  name: nameSchema.nullable(),
  workspace: z.strictObject({ id: canonicalIdSchema, name: nameSchema }),
  task: z.strictObject({ id: canonicalIdSchema, name: nameSchema, status: z.enum(['open', 'done', 'archived']) }).nullable(),
  agent: z.strictObject({ id: canonicalIdSchema, name: nameSchema, proxy: nameSchema }),
  status: z.enum(SESSION_STATUSES),
  unread: z.boolean(),
  waiting_for_user: z.boolean(),
  last_activity_at: unixMsSchema.nullable(),
  completed_at: boundedStringSchema.nullable(),
});
const directoryPageSchema = z.strictObject({
  version: z.literal(1),
  view: directoryViewSchema,
  as_of: unixMsSchema,
  revision: boundedStringSchema,
  entries: z.array(remoteDirectoryEntrySchema).max(DIRECTORY_PAGE_LIMIT),
});
export const directoryListResultSchema = z.discriminatedUnion('state', [
  directoryPageSchema.extend({ state: z.literal('complete'), next_cursor: z.null() }),
  directoryPageSchema.extend({ state: z.literal('incomplete'), next_cursor: z.string().min(1).max(4096) }),
  directoryPageSchema.extend({ state: z.literal('cursor_invalid'), entries: z.tuple([]), next_cursor: z.null() }),
]);

/** Live-only invalidation hint. No canonical replay sequence is consumed. */
export const directoryChangedSchema = z.strictObject({
  type: z.literal('directory.changed'),
  version: z.literal(1),
  host_generation: canonicalIdSchema,
  revision: boundedStringSchema,
});
export type DirectoryListParams = z.infer<typeof directoryListParamsSchema>;
export type DirectoryListResult = z.infer<typeof directoryListResultSchema>;
export type RemoteDirectoryEntry = z.infer<typeof remoteDirectoryEntrySchema>;
