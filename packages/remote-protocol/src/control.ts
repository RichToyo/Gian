import { z } from 'zod';
import { remoteAgentCatalogSchema, remoteConfigMapSchema, remoteConfigValueSchema, remoteConfigOptionSchema } from './catalog.js';

import {
  ATTENTION_KINDS,
  BUSINESS_CAPABILITY_IDS,
  COMMAND_STATUS_STATES,
  CONTENT_WINDOW_CHUNKS,
  DOWNLOAD_KINDS,
  INTERACTION_KINDS,
  MAX_ARRAY_ITEMS,
  MAX_ATTACHMENT_BYTES,
  MAX_CONTENT_CHUNK_PLAINTEXT_BYTES,
  MAX_FILE_PREVIEW_BYTES,
  MAX_HELLO_CAPABILITIES,
  MAX_PROXY_LOGO_BASE64_CHARS,
  MAX_QUEUE_ENTRIES,
  MAX_SESSION_PAGE_TURNS,
  MAX_SNAPSHOT_PARTS,
  MAX_SNAPSHOT_TOTAL_BYTES,
  MIN_SESSION_PAGE_TURNS,
  REMOTE_ERROR_CODES,
  REMOTE_MAJOR_VERSION,
  REMOTE_MAX_MINOR_VERSION,
  REMOTE_METHODS,
  REMOTE_MIN_MINOR_VERSION,
  REMOTE_PROTOCOL,
  SESSION_STATUSES,
  SNAPSHOT_REQUIRED_REASONS,
  WIRE_FEATURES,
} from './constants.js';
import { RemoteProtocolError } from './errors.js';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalJson,
  sha256Hex,
  utf8ByteLength,
} from './serialize.js';
import {
  base64Schema,
  boundedStringSchema,
  canonicalIdSchema,
  nameSchema,
  nonNegativeSafeIntegerSchema,
  parseClosed,
  positiveSafeIntegerSchema,
  remoteProtocolSchema,
  sha256HexSchema,
  unixMsSchema,
  uuidV7Schema,
  validateCommandIdentity,
  wireFeatureIdSchema,
} from './validation.js';

export const remoteMethodSchema = z.enum(REMOTE_METHODS);
export const remoteErrorCodeSchema = z.enum(REMOTE_ERROR_CODES);
export const wireFeatureSchema = z.enum(WIRE_FEATURES);

export const remoteCommandErrorSchema = z.strictObject({
  code: remoteErrorCodeSchema,
  message: boundedStringSchema,
});

const capabilityStateSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('supported') }),
  z.strictObject({ state: z.literal('unsupported'), reason: boundedStringSchema.optional() }),
  z.strictObject({ state: z.literal('offline'), reason: boundedStringSchema }),
  z.strictObject({ state: z.literal('denied'), reason: boundedStringSchema }),
  z.strictObject({ state: z.literal('version_mismatch'), reason: boundedStringSchema }),
]);

export const effectiveCapabilitiesSchema = z.strictObject({
  'catalog.read': capabilityStateSchema.optional(),
  'state.refresh': capabilityStateSchema.optional(),
  'task.read': capabilityStateSchema.optional(),
  'session.read': capabilityStateSchema.optional(),
  'session.create': capabilityStateSchema.optional(),
  'session.update': capabilityStateSchema.optional(),
  'session.send': capabilityStateSchema.optional(),
  'session.stop': capabilityStateSchema.optional(),
  'queue.read': capabilityStateSchema.optional(),
  'queue.add': capabilityStateSchema.optional(),
  'queue.update': capabilityStateSchema.optional(),
  'queue.remove': capabilityStateSchema.optional(),
  'queue.clear': capabilityStateSchema.optional(),
  'queue.send_now': capabilityStateSchema.optional(),
  'turn.steer': capabilityStateSchema.optional(),
  'interaction.read': capabilityStateSchema.optional(),
  'interaction.respond': capabilityStateSchema.optional(),
  'attachment.upload': capabilityStateSchema.optional(),
  'attachment.read': capabilityStateSchema.optional(),
  'file.read': capabilityStateSchema.optional(),
  'file.download': capabilityStateSchema.optional(),
});

export const remoteTaskSchema = z.strictObject({
  id: canonicalIdSchema,
  name: nameSchema,
  updated_at: boundedStringSchema,
  session_ids: z.array(canonicalIdSchema).max(MAX_ARRAY_ITEMS),
});

export const remoteAttachmentHandleSchema = z.strictObject({
  type: z.literal('attachment'),
  attachment_id: canonicalIdSchema,
});

export const remoteTextItemSchema = z.strictObject({
  type: z.literal('text'),
  text: boundedStringSchema,
});

export const remoteInputItemSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('compiled_text'), attachment_id: canonicalIdSchema }),
  remoteTextItemSchema,
  remoteAttachmentHandleSchema,
]);

export const remoteContextItemSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('pasted_text'),
    text: boundedStringSchema,
  }),
  z.strictObject({
    type: z.literal('file_ref'),
    handle_id: canonicalIdSchema,
  }),
]);

export const remoteComposerNodeSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: boundedStringSchema }),
  z.strictObject({ type: z.literal('reference'), handle_id: canonicalIdSchema }),
]);

export const remoteComposerDocumentSchema = z.strictObject({
  type: z.literal('document'),
  nodes: z.array(remoteComposerNodeSchema).max(MAX_ARRAY_ITEMS),
});

export const remoteQueueEntrySchema = z.strictObject({
  id: canonicalIdSchema,
  session_id: canonicalIdSchema,
  text: boundedStringSchema,
  created_at: boundedStringSchema,
  items: z.array(remoteInputItemSchema).max(32).optional(),
  context_items: z.array(remoteContextItemSchema).max(32).optional(),
  composer_document: remoteComposerDocumentSchema.optional(),
  delivery_id: canonicalIdSchema.optional(),
});

export const remoteSessionSchema = z.strictObject({
  id: canonicalIdSchema,
  revision: boundedStringSchema,
  name: nameSchema.nullable(),
  task_id: canonicalIdSchema.nullable(),
  workspace_id: canonicalIdSchema,
  agent: z.strictObject({
    id: canonicalIdSchema,
    name: nameSchema,
    proxy: nameSchema,
  }),
  model: nameSchema.nullable().optional(),
  thinking: nameSchema.nullable().optional(),
  service_tier: nameSchema.nullable().optional(),
  approval_mode: nameSchema.nullable().optional(),
  context_tokens_used: nonNegativeSafeIntegerSchema.nullable().optional(),
  context_window_tokens: nonNegativeSafeIntegerSchema.nullable().optional(),
  context_usage_updated_at: boundedStringSchema.nullable().optional(),
  status: z.enum(SESSION_STATUSES),
  unread: z.boolean().optional(),
  queue: z.strictObject({
    revision: boundedStringSchema,
    entries: z.array(remoteQueueEntrySchema).max(MAX_QUEUE_ENTRIES),
  }),
  updated_at: boundedStringSchema,
  active_turn: z.strictObject({
    id: canonicalIdSchema,
    turn_number: positiveSafeIntegerSchema,
  }).optional(),
});

export const remoteInteractionSchema = z.strictObject({
  id: canonicalIdSchema,
  revision: boundedStringSchema,
  session_id: canonicalIdSchema,
  turn_id: canonicalIdSchema,
  kind: z.enum(INTERACTION_KINDS),
  created_at: boundedStringSchema,
  presentation: z.strictObject({
    title: nameSchema,
    description: boundedStringSchema,
    risk: z.enum(['low', 'medium', 'high']),
    actions: z.array(z.strictObject({
      id: canonicalIdSchema,
      label: nameSchema,
      tone: z.enum(['default', 'danger']),
    })).max(16),
    subject: boundedStringSchema.optional(),
    inputs: z.array(z.strictObject({
      id: canonicalIdSchema,
      label: nameSchema,
      type: z.enum(['text', 'multiline_text', 'single_select', 'multi_select', 'boolean']),
      options: z.array(z.strictObject({
        value: boundedStringSchema,
        label: nameSchema,
        description: boundedStringSchema.optional(),
      })).max(32).optional(),
    })).max(16).optional(),
  }),
});

export const remoteAttentionSchema = z.strictObject({
  session_id: canonicalIdSchema,
  kind: z.enum(ATTENTION_KINDS),
  updated_at: boundedStringSchema,
});

export const remoteFileRefSchema = z.strictObject({
  id: canonicalIdSchema,
  reference: z.string().min(1).max(4096).optional(),
  session_id: canonicalIdSchema,
  name: nameSchema,
  mime: nameSchema,
  size: nonNegativeSafeIntegerSchema.max(MAX_ATTACHMENT_BYTES),
  revision: boundedStringSchema,
  previewable: z.boolean(),
  downloadable: z.boolean(),
  expires_at: boundedStringSchema,
});

export const remoteLocaleSchema = z.enum(['en', 'zh-CN']);

/**
 * Minimal conversation-translation display DTO (wire.conversation_translation).
 * Deliberately NOT the Host's full TranslationRecord: no Agent id, model,
 * Composer document, local path, or provider error ever crosses the relay.
 * `source_sha256` is the match identity a client verifies against the message
 * text it already has; `source_id` carries the Host's stable turn/delivery
 * association (`turn:N` for reading translations).
 *
 * Full-fidelity text: `text` is present only when the COMPLETE translation
 * fits the wire text bound. Otherwise the descriptor (`text_length` +
 * `text_sha256`) describes the full content and the client pages it through
 * `translation.result_text`, verifying the hash after assembly — a prefix is
 * never served as if it were the whole translation.
 */
export const remoteTranslationSchema = z.strictObject({
  id: canonicalIdSchema,
  session_id: canonicalIdSchema,
  purpose: z.enum(['send', 'read']),
  source_id: boundedStringSchema.optional(),
  target_language: nameSchema,
  text: boundedStringSchema.optional(),
  text_length: nonNegativeSafeIntegerSchema,
  text_sha256: sha256HexSchema,
  source_sha256: sha256HexSchema,
});
export type RemoteTranslation = z.infer<typeof remoteTranslationSchema>;

/** Inline send-translation summary on a user transcript item. Same
 *  full-fidelity rule as remoteTranslationSchema: `text` only when complete. */
export const remoteSentTranslationSchema = z.strictObject({
  /** The Host receipt id — the client pages the full text via
   *  translation.result_text when `text` is absent. */
  id: canonicalIdSchema,
  text: boundedStringSchema.optional(),
  text_length: nonNegativeSafeIntegerSchema,
  text_sha256: sha256HexSchema,
  target_language: nameSchema,
});
export type RemoteSentTranslation = z.infer<typeof remoteSentTranslationSchema>;

export const remoteTranslationAutomaticSchema = z.strictObject({
  source_id: boundedStringSchema,
  pending: z.boolean(),
  error: boundedStringSchema.optional(),
});
export type RemoteTranslationAutomatic = z.infer<typeof remoteTranslationAutomaticSchema>;

/** Per-session translation state: the Host is the single source of truth.
 *  `configured` reports whether the Host's saved translation preferences are
 *  usable, so the client can mirror the local "configure first" hint without
 *  ever seeing the Agent/model selection itself. */
export const remoteTranslationStateSchema = z.strictObject({
  enabled: z.boolean(),
  configured: z.boolean(),
  sending_language: nameSchema,
  reading_language: nameSchema,
  /** Monotonic per-session switch revision. Clients apply a state only when
   *  its revision is not older than the one they already hold, so a delayed
   *  command result or replayed event can never roll back a newer toggle. */
  revision: nonNegativeSafeIntegerSchema,
  /** Monotonic Host-wide revision of the saved translation preferences
   *  (configured/languages), bumped on each Settings save — covers the
   *  wholesale-replace fields the per-session revision does not. */
  config_revision: nonNegativeSafeIntegerSchema,
  /** Per-session monotonic version of the automatic-progress map; bumped on
   *  every progress write/clear. A wholesale state applies `automatic` only
   *  when this is not older than the view's — a stale snapshot can never
   *  resurrect a pending entry over a settled failure/clear. */
  automatic_revision: nonNegativeSafeIntegerSchema,
  /** Host process-boot identity: after a restart the counters restart too;
   *  a different epoch tells views to accept the fresh baseline wholesale. */
  automatic_epoch: boundedStringSchema,
  automatic: z.array(remoteTranslationAutomaticSchema).max(MAX_ARRAY_ITEMS),
});
export type RemoteTranslationState = z.infer<typeof remoteTranslationStateSchema>;

export const remoteStateSnapshotSchema = z.strictObject({
  type: z.literal('state.snapshot'),
  snapshot_id: canonicalIdSchema,
  host_generation: canonicalIdSchema,
  revision: boundedStringSchema,
  event_sequence: nonNegativeSafeIntegerSchema,
  host: z.strictObject({
    id: canonicalIdSchema,
    name: nameSchema,
    online: z.literal(true),
    version: boundedStringSchema,
    /** Host-configured UI locale. Sent only when `wire.host_locale` was
     *  negotiated; receivers treat an absent value as 'en'. */
    locale: remoteLocaleSchema.optional(),
  }),
  workspaces: z.array(z.strictObject({
    id: canonicalIdSchema,
    name: nameSchema,
  })).max(MAX_ARRAY_ITEMS),
  tasks: z.array(remoteTaskSchema).max(MAX_ARRAY_ITEMS),
  sessions: z.array(remoteSessionSchema).max(MAX_ARRAY_ITEMS),
  interactions: z.array(remoteInteractionSchema).max(MAX_ARRAY_ITEMS),
  capabilities: effectiveCapabilitiesSchema,
  attention: z.array(remoteAttentionSchema).max(MAX_ARRAY_ITEMS),
  catalog_revision: boundedStringSchema,
});

export const remoteStatePatchBodySchema = z.strictObject({
  workspaces: z.strictObject({
    upsert: z.array(z.strictObject({ id: canonicalIdSchema, name: nameSchema })).max(MAX_ARRAY_ITEMS),
    remove_ids: z.array(canonicalIdSchema).max(MAX_ARRAY_ITEMS),
  }).optional(),
  tasks: z.strictObject({
    upsert: z.array(remoteTaskSchema).max(MAX_ARRAY_ITEMS),
    remove_ids: z.array(canonicalIdSchema).max(MAX_ARRAY_ITEMS),
  }).optional(),
  sessions: z.strictObject({
    upsert: z.array(remoteSessionSchema).max(MAX_ARRAY_ITEMS),
    remove_ids: z.array(canonicalIdSchema).max(MAX_ARRAY_ITEMS),
  }).optional(),
  interactions: z.strictObject({
    upsert: z.array(remoteInteractionSchema).max(MAX_ARRAY_ITEMS),
    remove_ids: z.array(canonicalIdSchema).max(MAX_ARRAY_ITEMS),
  }).optional(),
  queues: z.array(z.strictObject({
    session_id: canonicalIdSchema,
    queue_revision: boundedStringSchema,
    entries: z.array(remoteQueueEntrySchema).max(MAX_QUEUE_ENTRIES),
  })).max(MAX_ARRAY_ITEMS).optional(),
  capabilities: effectiveCapabilitiesSchema.optional(),
  attention: z.array(remoteAttentionSchema).max(MAX_ARRAY_ITEMS).optional(),
  catalog_invalidated: z.strictObject({
    catalog_revision: boundedStringSchema,
  }).optional(),
});

export const commandExpectedSchema = z.strictObject({
  host_generation: canonicalIdSchema,
  state_revision: boundedStringSchema.optional(),
  catalog_revision: boundedStringSchema.optional(),
  session_revision: boundedStringSchema.optional(),
  queue_revision: boundedStringSchema.optional(),
  interaction_id: canonicalIdSchema.optional(),
  interaction_revision: boundedStringSchema.optional(),
});

export const catalogReadParamsSchema = z.strictObject({});
export const stateRefreshParamsSchema = z.strictObject({
  session_id: canonicalIdSchema.optional(),
});
export const sessionSubscribeParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
});
export const sessionPageParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  cursor: boundedStringSchema.optional(),
  turns: z.number().int().min(MIN_SESSION_PAGE_TURNS).max(MAX_SESSION_PAGE_TURNS).optional(),
});
export const commandStatusParamsSchema = z.strictObject({
  command_id: uuidV7Schema,
});
export const sessionCreateParamsSchema = z.strictObject({
  catalog_revision: boundedStringSchema,
  workspace_id: canonicalIdSchema,
  agent_id: canonicalIdSchema,
  task_id: canonicalIdSchema.optional(),
  name: nameSchema.optional(),
  model: nameSchema.optional(),
  thinking: nameSchema.optional(),
  service_tier: z.enum(['standard', 'fast']).optional(),
});
export const sessionUpdateParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  session_revision: boundedStringSchema,
  name: nameSchema.optional(),
  model: nameSchema.nullable().optional(),
  thinking: nameSchema.nullable().optional(),
  service_tier: z.enum(['standard', 'fast']).optional(),
  approval_mode: nameSchema.nullable().optional(),
});
export const sessionSendParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  text: z.string().max(64 * 1024),
  busy: z.enum(['queue', 'fail', 'steer']).optional(),
  items: z.array(remoteInputItemSchema).max(32).optional(),
  context_items: z.array(remoteContextItemSchema).max(32).optional(),
  composer_document: remoteComposerDocumentSchema.optional(),
  /** Send-gate receipt from translation.request (purpose=send), or the
   *  literal 'original' for an explicit untranslated send. Only accepted on
   *  connections that negotiated wire.conversation_translation; the Host
   *  revalidates the receipt against the stored record before dispatch. */
  translation_id: z.union([canonicalIdSchema, z.literal('original')]).optional(),
});
export const sessionStopParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  session_revision: boundedStringSchema,
});
export const queueUpdateParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  queue_id: canonicalIdSchema,
  text: boundedStringSchema,
  expected_queue_revision: boundedStringSchema,
});
export const queueRemoveParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  queue_id: canonicalIdSchema,
  expected_queue_revision: boundedStringSchema,
});
export const queueClearParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  expected_queue_revision: boundedStringSchema,
});
export const queueSendNowParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  expected_queue_revision: boundedStringSchema,
});
export const interactionRespondParamsSchema = z.strictObject({
  interaction_id: canonicalIdSchema,
  interaction_revision: boundedStringSchema,
  action_id: canonicalIdSchema,
  values: z.record(
    z.string().min(1).max(64),
    z.union([z.string().max(4000), z.boolean(), z.array(z.string().max(256)).max(16)]),
  ).optional(),
});
export const filePreviewParamsSchema = z.strictObject({
  handle_id: canonicalIdSchema,
});
export const translationStateParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
});
export const translationSetAutoParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  /** Explicit target value — never a blind toggle. The Host's persisted
   *  record is the authority; the result carries the confirmed value. */
  enabled: z.boolean(),
  /** Optional optimistic precondition: when present, the write fails with
   *  PRECONDITION_FAILED if the persisted value no longer matches, so a
   *  stale view cannot silently flip another device's newer choice. */
  expected_enabled: z.boolean().optional(),
  /** Optional stronger precondition on the monotonic state revision. */
  expected_revision: nonNegativeSafeIntegerSchema.optional(),
});
export const translationRequestParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  /** Client-minted request identity, stable across UI retries. */
  request_id: z.string().min(1).max(128),
  purpose: z.enum(['send', 'read']),
  text: z.string().min(1).max(120_000),
  source_id: z.string().min(1).max(256).optional(),
  composer_document: remoteComposerDocumentSchema.optional(),
});
export const translationCancelParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  request_id: z.string().min(1).max(128),
});
/** Bounded full-text paging for descriptor-only translation DTOs. Offsets are
 *  JS string positions; each page returns at most one wire text chunk. */
export const translationResultTextParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  record_id: canonicalIdSchema,
  offset: nonNegativeSafeIntegerSchema.optional(),
});
/** Terminal-status recovery for a translation.request identity (F7): a lost
 *  settle event is re-queryable instead of leaving a permanent pending row. */
export const translationRequestStatusParamsSchema = z.strictObject({
  session_id: canonicalIdSchema,
  request_id: z.string().min(1).max(128),
});
export const proxyLogoParamsSchema = z.strictObject({
  proxy: nameSchema,
  variant: z.enum(['light', 'dark']),
});

export const REMOTE_METHOD_PARAMS = {
  'execution.create': sessionCreateParamsSchema.omit({ task_id: true }).extend({ approval_mode: nameSchema.optional(),
    session_config: remoteConfigMapSchema.optional(), turn_config: remoteConfigMapSchema.optional() }),
  'execution.configure': z.strictObject({ session_id: canonicalIdSchema, session_revision: boundedStringSchema,
    option_id: nameSchema, value: remoteConfigValueSchema, binding: z.enum(['session', 'turn']) }),
  'catalog.agent': z.strictObject({ agent_id: canonicalIdSchema, catalog_revision: nameSchema.optional(),
    session_config: remoteConfigMapSchema.optional(), turn_config: remoteConfigMapSchema.optional() }),
  'execution.list': z.strictObject({ after: canonicalIdSchema.optional() }),
  'execution.sync': z.strictObject({ session_id: canonicalIdSchema, after: nonNegativeSafeIntegerSchema,
    stream_id: canonicalIdSchema.optional() }),
  'catalog.read': catalogReadParamsSchema,
  'state.refresh': stateRefreshParamsSchema,
  'session.subscribe': sessionSubscribeParamsSchema,
  'session.page': sessionPageParamsSchema,
  'command.status': commandStatusParamsSchema,
  'session.create': sessionCreateParamsSchema,
  'session.update': sessionUpdateParamsSchema,
  'session.send': sessionSendParamsSchema,
  'session.stop': sessionStopParamsSchema,
  'queue.update': queueUpdateParamsSchema,
  'queue.remove': queueRemoveParamsSchema,
  'queue.clear': queueClearParamsSchema,
  'queue.send_now': queueSendNowParamsSchema,
  'interaction.respond': interactionRespondParamsSchema,
  'translation.state': translationStateParamsSchema,
  'translation.set_auto': translationSetAutoParamsSchema,
  'translation.request': translationRequestParamsSchema,
  'translation.cancel': translationCancelParamsSchema,
  'translation.result_text': translationResultTextParamsSchema,
  'translation.request_status': translationRequestStatusParamsSchema,
  'file.preview': filePreviewParamsSchema,
  'file.resolve': z.strictObject({ session_id: canonicalIdSchema, reference: z.string().min(1).max(4096) }),
  'file.tree': z.strictObject({ session_id: canonicalIdSchema, directory: z.string().max(4096),
    after: z.string().max(256).optional() }),
  'file.list': z.strictObject({ session_id: canonicalIdSchema, after: z.string().max(4096).optional() }),
  'git.read': z.strictObject({ session_id: canonicalIdSchema,
    operation: z.enum(['changed', 'diff', 'branches', 'commits', 'history', 'history_commit', 'history_diff', 'history_reachability']),
    reference: z.string().max(4096).optional(), scope: z.enum(['all', 'staged', 'unstaged', 'commit', 'branch', 'lastturn']).optional(),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(), base: z.string().max(256).optional(),
    turn: positiveSafeIntegerSchema.optional(), root: z.string().max(4096).optional(),
    cursor: z.string().max(4096).optional(), query: z.string().max(1024).optional(),
    ref: z.string().max(256).optional(), author: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  'proxy.logo': proxyLogoParamsSchema,
} as const;

export const catalogReadResultSchema = z.strictObject({
  catalog_revision: boundedStringSchema,
  workspaces: z.array(z.strictObject({
    id: canonicalIdSchema,
    name: nameSchema,
  })).max(MAX_ARRAY_ITEMS),
  agents: z.array(z.strictObject({
    id: canonicalIdSchema,
    name: nameSchema,
    proxy: nameSchema,
    readiness: z.enum(['ready', 'unavailable']),
    defaults: z.strictObject({
      model: nameSchema.optional(),
      thinking: nameSchema.optional(),
      service_tier: z.enum(['standard', 'fast']).optional(),
    }).optional(),
    models: z.array(z.strictObject({
      id: nameSchema,
      label: nameSchema,
      is_default: z.boolean(),
      supported_thinking: z.array(nameSchema).max(32),
    })).max(MAX_ARRAY_ITEMS).optional(),
  })).max(MAX_ARRAY_ITEMS),
  tasks: z.array(z.strictObject({
    id: canonicalIdSchema,
    name: nameSchema,
  })).max(MAX_ARRAY_ITEMS),
});

export const commandStatusResultSchema = z.strictObject({
  command_id: uuidV7Schema,
  state: z.enum(COMMAND_STATUS_STATES),
  result: z.unknown().optional(),
  error: remoteCommandErrorSchema.optional(),
});

export const sessionStopResultSchema = z.strictObject({
  already_idle: z.boolean(),
  session_revision: boundedStringSchema,
});

export const queueReplacementResultSchema = z.strictObject({
  queue: z.array(remoteQueueEntrySchema).max(MAX_QUEUE_ENTRIES),
  queue_revision: boundedStringSchema,
});

export const filePreviewResultSchema = z.strictObject({
  transfer_id: canonicalIdSchema,
  file: remoteFileRefSchema,
  preview_max_bytes: z.literal(MAX_FILE_PREVIEW_BYTES),
});

/** Branding bytes for one Proxy, so Remote clients can render the same logo
 *  local Web serves over HTTP. Read-only; carries no device grant. */
export const proxyLogoResultSchema = z.strictObject({
  media_type: z.enum(['image/png', 'image/webp']),
  data_base64: base64Schema.min(1).max(MAX_PROXY_LOGO_BASE64_CHARS),
  sha256: sha256HexSchema,
});

const transcriptItemBaseSchema = {
  id: canonicalIdSchema,
  turn_id: canonicalIdSchema,
  turn: nonNegativeSafeIntegerSchema,
  ts: unixMsSchema,
};

/**
 * Closed, presentation-only transcript contract. Remote clients must receive
 * the same logical event kinds as local Web without exposing provider-native
 * payloads, absolute paths, stderr, stacks, or credentials.
 */
export const transcriptItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('user'),
    text: boundedStringSchema,
    delivery_id: canonicalIdSchema.optional(),
    attachments: z.array(remoteFileRefSchema).max(32).optional(),
    /** Sent-translation summary, projected from the canonical user event's
     *  receipt. Present only when wire.conversation_translation was
     *  negotiated AND this message was dispatched translated. */
    translation: remoteSentTranslationSchema.optional(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('assistant'),
    text: boundedStringSchema,
    delta: z.boolean(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('command'),
    status: z.enum(['running', 'success', 'error']),
    exit_code: z.number().int().optional(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('file-change'),
    file_count: nonNegativeSafeIntegerSchema,
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('file-read'),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('file-search'),
    search_kind: z.enum(['glob', 'grep']),
    match_count: nonNegativeSafeIntegerSchema.optional(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('web-search'),
    result_count: nonNegativeSafeIntegerSchema.optional(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('tool'),
    name: nameSchema,
    status: z.enum(['pending', 'running', 'success', 'error']),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('agent'),
    status: z.enum(['running', 'done', 'error']),
    agent_type: nameSchema.optional(),
    model: nameSchema.optional(),
    background: z.boolean().optional(),
    started_at: unixMsSchema,
    completed_at: unixMsSchema.optional(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('notice'),
    severity: z.enum(['info', 'warning', 'error']),
    code: nameSchema,
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('classifier-denied'),
    consecutive: nonNegativeSafeIntegerSchema,
    total: nonNegativeSafeIntegerSchema,
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('circuit-breaker'),
    trigger: z.enum(['consecutive', 'total']),
    consecutive: nonNegativeSafeIntegerSchema,
    total: nonNegativeSafeIntegerSchema,
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('turn-end'),
    outcome: z.enum(['worked', 'failed', 'stopped']),
    source_turn_id: boundedStringSchema.optional(),
  }),
  z.strictObject({
    ...transcriptItemBaseSchema,
    kind: z.literal('error'),
  }),
]);

export const stateSnapshotPendingSchema = z.strictObject({
  type: z.literal('state.snapshot.pending'),
  snapshot_id: canonicalIdSchema,
});

export const stateRefreshResultSchema = z.union([remoteStateSnapshotSchema, stateSnapshotPendingSchema]);

export const executionSessionSchema = remoteSessionSchema.extend({
  worktree_root: boundedStringSchema,
  session_config: remoteConfigMapSchema,
  turn_config: remoteConfigMapSchema,
  turn_config_options: z.array(remoteConfigOptionSchema).max(128).optional(),
  context_tokens_used: nonNegativeSafeIntegerSchema.nullable(),
  context_window_tokens: nonNegativeSafeIntegerSchema.nullable(),
  context_usage_updated_at: boundedStringSchema.nullable(),
  conversation_input_tokens: nonNegativeSafeIntegerSchema.nullable(),
  conversation_output_tokens: nonNegativeSafeIntegerSchema.nullable(),
  conversation_cached_input_tokens: nonNegativeSafeIntegerSchema.nullable(),
  conversation_total_tokens: nonNegativeSafeIntegerSchema.nullable(),
  conversation_usage_complete: z.boolean(),
});

export const executionHistoryEntrySchema = z.union([
  z.strictObject({ sequence: positiveSafeIntegerSchema, interaction: remoteInteractionSchema, turn: nonNegativeSafeIntegerSchema }),
  z.strictObject({ sequence: positiveSafeIntegerSchema, item: transcriptItemSchema }),
  z.strictObject({ sequence: positiveSafeIntegerSchema, resolution: z.strictObject({
    interaction_id: canonicalIdSchema, decision: z.enum(['allow_once', 'allow_session', 'decline']),
    auto: z.boolean(), turn: nonNegativeSafeIntegerSchema, ts: unixMsSchema,
    answers: z.record(z.string().min(1).max(256), z.union([z.string().max(4000), z.array(z.string().max(4000)).max(16)]))
      .refine(value => Object.keys(value).length <= 16).optional(),
  }) }),
]);
export type ExecutionHistoryEntry = z.infer<typeof executionHistoryEntrySchema>;
export const executionSyncResultSchema = z.strictObject({
  stream_id: canonicalIdSchema,
  cursor: nonNegativeSafeIntegerSchema,
  has_more: z.boolean(),
  session: executionSessionSchema,
  events: z.array(executionHistoryEntrySchema).max(128),
  interactions: z.array(remoteInteractionSchema).max(MAX_ARRAY_ITEMS),
});
export type ExecutionSyncResult = z.infer<typeof executionSyncResultSchema>;
export type ExecutionSession = z.infer<typeof executionSessionSchema>;

export const REMOTE_METHOD_RESULTS = {
  'execution.create': executionSessionSchema,
  'execution.configure': executionSessionSchema,
  'catalog.agent': remoteAgentCatalogSchema,
  'execution.list': z.strictObject({ sessions: z.array(executionSessionSchema).max(100), has_more: z.boolean() }),
  'execution.sync': executionSyncResultSchema,
  'catalog.read': catalogReadResultSchema,
  'state.refresh': stateRefreshResultSchema,
  'session.subscribe': z.strictObject({
    session: remoteSessionSchema,
    cursor: boundedStringSchema,
    /** Present only when wire.conversation_translation was negotiated. */
    translation: remoteTranslationStateSchema.optional(),
  }),
  'session.page': z.strictObject({
    session_id: canonicalIdSchema,
    cursor: boundedStringSchema.optional(),
    has_more: z.boolean(),
    items: z.array(transcriptItemSchema).max(MAX_ARRAY_ITEMS),
    /** Reading translations for this page's turns. Present only when
     *  wire.conversation_translation was negotiated. */
    translations: z.array(remoteTranslationSchema).max(MAX_ARRAY_ITEMS).optional(),
  }),
  'command.status': commandStatusResultSchema,
  'session.create': remoteSessionSchema,
  'session.update': remoteSessionSchema,
  'session.send': z.strictObject({
    session: remoteSessionSchema,
    delivery_id: canonicalIdSchema.optional(),
    delivery_state: z.enum(['started', 'queued', 'steered', 'completed', 'error', 'stopped', 'cancelled', 'unknown']).optional(),
    queue_id: canonicalIdSchema.optional(),
    turn_number: positiveSafeIntegerSchema.optional(),
  }),
  'session.stop': sessionStopResultSchema,
  'queue.update': queueReplacementResultSchema,
  'queue.remove': queueReplacementResultSchema,
  'queue.clear': queueReplacementResultSchema,
  'queue.send_now': z.strictObject({
    mode: z.enum(['noop', 'started', 'steered']),
    affected: z.array(z.strictObject({ queue_id: canonicalIdSchema, state: z.enum(['started', 'steered']),
      turn_number: positiveSafeIntegerSchema })).max(MAX_QUEUE_ENTRIES).optional(),
    queue: z.array(remoteQueueEntrySchema).max(MAX_QUEUE_ENTRIES),
    queue_revision: boundedStringSchema,
  }),
  'interaction.respond': z.strictObject({
    interaction_id: canonicalIdSchema,
    revision: boundedStringSchema,
    resolved: z.literal(true),
  }),
  'translation.state': remoteTranslationStateSchema,
  'translation.set_auto': remoteTranslationStateSchema,
  /** Accepted receipt. The settled record (or a safe error) arrives as a
   *  translation.updated event carrying the same request_id, so a long model
   *  call never holds the per-device command chain or a read timeout. */
  'translation.request': z.strictObject({
    request_id: boundedStringSchema,
    status: z.literal('accepted'),
  }),
  'translation.cancel': z.strictObject({
    ok: z.literal(true),
  }),
  'translation.result_text': z.strictObject({
    /** Next chunk of the complete text (at most one wire text bound). */
    text: boundedStringSchema,
    /** Present while more content follows; absent marks the final chunk. */
    next_offset: nonNegativeSafeIntegerSchema.optional(),
  }),
  'translation.request_status': z.strictObject({
    state: z.enum(['unknown', 'pending', 'succeeded', 'failed']),
    record: remoteTranslationSchema.optional(),
    error: boundedStringSchema.optional(),
  }),
  'file.preview': filePreviewResultSchema,
  'file.resolve': remoteFileRefSchema,
  'file.tree': z.strictObject({ entries: z.array(z.strictObject({ name: nameSchema,
    reference: boundedStringSchema, kind: z.enum(['file', 'directory']) })).max(200), has_more: z.boolean() }),
  'file.list': z.strictObject({ references: z.array(z.string().max(4096)).max(200), has_more: z.boolean() }),
  'git.read': z.strictObject({ result_json: z.string().max(192 * 1024) }),
  'proxy.logo': proxyLogoResultSchema,
} as const;

export function parseRemoteMethodParams(method: RemoteMethod, params: unknown): unknown {
  return parseClosed(REMOTE_METHOD_PARAMS[method] as z.ZodType<unknown>, params);
}

export const helloSchema = z.strictObject({
  type: z.literal('hello'),
  protocol: remoteProtocolSchema,
  client_version: boundedStringSchema,
  major_version: z.literal(REMOTE_MAJOR_VERSION),
  min_minor_version: nonNegativeSafeIntegerSchema,
  max_minor_version: nonNegativeSafeIntegerSchema,
  capabilities: z.array(wireFeatureIdSchema).max(MAX_HELLO_CAPABILITIES),
  device_id: canonicalIdSchema,
  last_host_generation: canonicalIdSchema.optional(),
  last_event_sequence: nonNegativeSafeIntegerSchema.optional(),
  current_revision: boundedStringSchema.optional(),
}).refine(
  (value) => value.min_minor_version <= value.max_minor_version,
  'min_minor_version must be <= max_minor_version.',
);

export const helloOkSchema = z.strictObject({
  type: z.literal('hello.ok'),
  protocol: remoteProtocolSchema,
  host_version: boundedStringSchema,
  host_generation: canonicalIdSchema,
  connection_id: canonicalIdSchema,
  negotiated_major_version: z.literal(REMOTE_MAJOR_VERSION),
  negotiated_minor_version: nonNegativeSafeIntegerSchema,
  negotiated_capabilities: z.array(wireFeatureSchema).max(MAX_HELLO_CAPABILITIES),
  server_time: unixMsSchema,
});

export const stateSnapshotPartSchema = z.strictObject({
  type: z.literal('state.snapshot.part'),
  snapshot_id: canonicalIdSchema,
  host_generation: canonicalIdSchema,
  revision: boundedStringSchema,
  event_sequence: nonNegativeSafeIntegerSchema,
  part_index: nonNegativeSafeIntegerSchema,
  part_total: positiveSafeIntegerSchema.max(MAX_SNAPSHOT_PARTS),
  payload_size: positiveSafeIntegerSchema.max(MAX_SNAPSHOT_TOTAL_BYTES),
  payload_sha256: sha256HexSchema,
  bytes: z.string().min(1),
});

export const resumeRequestSchema = z.strictObject({
  type: z.literal('resume.request'),
  host_generation: canonicalIdSchema,
  after_event_sequence: nonNegativeSafeIntegerSchema,
  current_revision: boundedStringSchema,
  subscribed_session_id: canonicalIdSchema.optional(),
  transcript_cursor: boundedStringSchema.optional(),
});

export const resumeOkSchema = z.strictObject({
  type: z.literal('resume.ok'),
  host_generation: canonicalIdSchema,
  replay_from: nonNegativeSafeIntegerSchema,
  replay_through: nonNegativeSafeIntegerSchema,
  revision: boundedStringSchema,
  transcript_included: z.boolean().optional(),
});

/** Host-pushed transcript history that rides a resume so the device does not
 *  need a session.page round trip after reconnecting with a subscription. */
export const transcriptPageSchema = z.strictObject({
  type: z.literal('transcript.page'),
  session_id: canonicalIdSchema,
  cursor: boundedStringSchema.optional(),
  has_more: z.boolean(),
  items: z.array(transcriptItemSchema).max(MAX_ARRAY_ITEMS),
  /** Reading translations for this page's turns; only sent when
   *  wire.conversation_translation was negotiated. */
  translations: z.array(remoteTranslationSchema).max(MAX_ARRAY_ITEMS).optional(),
});

export const snapshotRequiredSchema = z.strictObject({
  type: z.literal('snapshot.required'),
  reason: z.enum(SNAPSHOT_REQUIRED_REASONS),
});

export const commandRequestSchema = z.strictObject({
  type: z.literal('command.request'),
  command_id: uuidV7Schema,
  created_at: unixMsSchema,
  attempt_id: canonicalIdSchema,
  method: remoteMethodSchema,
  params: z.unknown(),
  expected: commandExpectedSchema.optional(),
});

export const commandAcceptedSchema = z.strictObject({
  type: z.literal('command.accepted'),
  command_id: uuidV7Schema,
  attempt_id: canonicalIdSchema,
});

export const commandResultSchema = z.strictObject({
  type: z.literal('command.result'),
  command_id: uuidV7Schema,
  attempt_id: canonicalIdSchema,
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: remoteCommandErrorSchema.optional(),
});

export const remoteEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session.updated'), session: remoteSessionSchema }),
  z.strictObject({ kind: z.literal('interaction.updated'), interaction: remoteInteractionSchema }),
  z.strictObject({
    kind: z.literal('attention.updated'),
    attention: z.array(remoteAttentionSchema).max(MAX_ARRAY_ITEMS),
  }),
  z.strictObject({
    kind: z.literal('transcript.item'),
    session_id: canonicalIdSchema,
    item: transcriptItemSchema,
  }),
  /** Conversation-translation delta. Only ever sent to connections that
   *  negotiated wire.conversation_translation (legacy and non-negotiated
   *  peers parse canonical events closed and must never see this kind).
   *  `state` replaces the small per-session state outright (toggle, Host
   *  preference change); `automatic` is a single-source progress delta;
   *  `upsert` is a newly settled record; `request_id` correlates a
   *  translation.request waiter with its settled outcome and `error` is a
   *  redacted, display-safe message. */
  z.strictObject({
    kind: z.literal('translation.updated'),
    session_id: canonicalIdSchema,
    state: remoteTranslationStateSchema.optional(),
    automatic: remoteTranslationAutomaticSchema.optional(),
    /** Ordered version of an `automatic` delta, shared with the wholesale
     *  state's automatic_revision/automatic_epoch: a delta advances the
     *  view's version, and a stale snapshot or delta can never resurrect an
     *  older pending entry over a settled outcome. */
    automatic_revision: nonNegativeSafeIntegerSchema.optional(),
    automatic_epoch: boundedStringSchema.optional(),
    upsert: remoteTranslationSchema.optional(),
    request_id: boundedStringSchema.optional(),
    error: boundedStringSchema.optional(),
  }),
]);

export const canonicalEventSchema = z.strictObject({
  type: z.literal('event'),
  host_generation: canonicalIdSchema,
  event_sequence: nonNegativeSafeIntegerSchema,
  event: remoteEventSchema,
});

export const statePatchSchema = z.strictObject({
  type: z.literal('state.patch'),
  host_generation: canonicalIdSchema,
  event_sequence: nonNegativeSafeIntegerSchema,
  base_revision: boundedStringSchema,
  revision: boundedStringSchema,
  patch: remoteStatePatchBodySchema,
});

export const attachmentBeginSchema = z.strictObject({
  type: z.literal('attachment.begin'),
  transfer_id: canonicalIdSchema,
  upload_id: canonicalIdSchema,
  session_id: canonicalIdSchema,
  name: nameSchema,
  mime: nameSchema,
  size: positiveSafeIntegerSchema.max(MAX_ATTACHMENT_BYTES),
  sha256: sha256HexSchema,
});

export const attachmentChunkSchema = z.strictObject({
  type: z.literal('attachment.chunk'),
  transfer_id: canonicalIdSchema,
  transfer_sequence: nonNegativeSafeIntegerSchema,
  offset: nonNegativeSafeIntegerSchema,
  bytes: z.string().min(1),
});

export const transferAckSchema = z.strictObject({
  type: z.literal('transfer.ack'),
  transfer_id: canonicalIdSchema,
  contiguous_offset: nonNegativeSafeIntegerSchema,
  window_chunks: z.number().int().min(1).max(CONTENT_WINDOW_CHUNKS),
});

export const transferCancelSchema = z.strictObject({
  type: z.literal('transfer.cancel'),
  transfer_id: canonicalIdSchema,
  reason: boundedStringSchema,
});

export const transferErrorSchema = z.strictObject({
  type: z.literal('transfer.error'),
  transfer_id: canonicalIdSchema,
  code: remoteErrorCodeSchema,
  message: boundedStringSchema,
});

export const attachmentCompleteSchema = z.strictObject({
  type: z.literal('attachment.complete'),
  transfer_id: canonicalIdSchema,
  upload_id: canonicalIdSchema,
});

export const attachmentResultSchema = z.strictObject({
  type: z.literal('attachment.result'),
  transfer_id: canonicalIdSchema,
  upload_id: canonicalIdSchema,
  attachment_id: canonicalIdSchema,
  name: nameSchema,
  mime: nameSchema,
  size: positiveSafeIntegerSchema.max(MAX_ATTACHMENT_BYTES),
  sha256: sha256HexSchema,
  expires_at: boundedStringSchema,
});

export const downloadRequestSchema = z.strictObject({
  type: z.literal('download.request'),
  transfer_id: canonicalIdSchema,
  kind: z.enum(DOWNLOAD_KINDS),
  handle_id: canonicalIdSchema,
  offset: nonNegativeSafeIntegerSchema.optional(),
});

export const downloadMetadataSchema = z.strictObject({
  type: z.literal('download.metadata'),
  transfer_id: canonicalIdSchema,
  name: nameSchema,
  mime: nameSchema,
  size: nonNegativeSafeIntegerSchema.max(MAX_ATTACHMENT_BYTES),
  sha256: sha256HexSchema,
  disposition: z.enum(['inline', 'attachment']),
  preview: z.boolean(),
});

export const downloadCompleteSchema = z.strictObject({
  type: z.literal('download.complete'),
  transfer_id: canonicalIdSchema,
  size: nonNegativeSafeIntegerSchema,
  sha256: sha256HexSchema,
});

export const remoteErrorMessageSchema = z.strictObject({
  type: z.literal('error'),
  code: remoteErrorCodeSchema,
  message: boundedStringSchema,
  command_id: uuidV7Schema.optional(),
  attempt_id: canonicalIdSchema.optional(),
});

export const remoteControlMessageSchema = z.discriminatedUnion('type', [
  helloSchema,
  helloOkSchema,
  remoteStateSnapshotSchema,
  stateSnapshotPartSchema,
  resumeRequestSchema,
  resumeOkSchema,
  transcriptPageSchema,
  snapshotRequiredSchema,
  commandRequestSchema,
  commandAcceptedSchema,
  commandResultSchema,
  canonicalEventSchema,
  statePatchSchema,
  attachmentBeginSchema,
  attachmentChunkSchema,
  attachmentCompleteSchema,
  attachmentResultSchema,
  transferAckSchema,
  transferCancelSchema,
  transferErrorSchema,
  downloadRequestSchema,
  downloadMetadataSchema,
  downloadCompleteSchema,
  remoteErrorMessageSchema,
]);

export type RemoteMethod = (typeof REMOTE_METHODS)[number];
export type Hello = z.infer<typeof helloSchema>;
export type HelloOk = z.infer<typeof helloOkSchema>;
export type RemoteStateSnapshot = z.infer<typeof remoteStateSnapshotSchema>;
export type RemoteLocale = z.infer<typeof remoteLocaleSchema>;
export type StateSnapshotPart = z.infer<typeof stateSnapshotPartSchema>;
export type ResumeRequest = z.infer<typeof resumeRequestSchema>;
export type ResumeOk = z.infer<typeof resumeOkSchema>;
export type SnapshotRequired = z.infer<typeof snapshotRequiredSchema>;
export type CommandRequest = z.infer<typeof commandRequestSchema>;
export type CommandAccepted = z.infer<typeof commandAcceptedSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type CommandStatusResult = z.infer<typeof commandStatusResultSchema>;
export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;
export type StatePatch = z.infer<typeof statePatchSchema>;
export type RemoteStatePatch = z.infer<typeof remoteStatePatchBodySchema>;
export type RemoteControlMessage = z.infer<typeof remoteControlMessageSchema>;
export type RemoteSession = z.infer<typeof remoteSessionSchema>;
export type RemoteTask = z.infer<typeof remoteTaskSchema>;
export type RemoteQueueEntry = z.infer<typeof remoteQueueEntrySchema>;
export type RemoteAttention = z.infer<typeof remoteAttentionSchema>;
export type RemoteInteraction = z.infer<typeof remoteInteractionSchema>;
export type EffectiveCapabilities = z.infer<typeof effectiveCapabilitiesSchema>;
export type RemoteTranscriptItem = z.infer<typeof transcriptItemSchema>;

export function parseRemoteControlMessage(value: unknown): RemoteControlMessage {
  return parseClosed(remoteControlMessageSchema, value);
}

export const CONTENT_INNER_MESSAGE_TYPES = ['attachment.chunk'] as const;

export const CONTROL_INNER_MESSAGE_TYPES = [
  'hello',
  'hello.ok',
  'state.snapshot',
  'state.snapshot.part',
  'resume.request',
  'resume.ok',
  'transcript.page',
  'snapshot.required',
  'command.request',
  'command.accepted',
  'command.result',
  'event',
  'state.patch',
  'attachment.begin',
  'attachment.complete',
  'attachment.result',
  'transfer.ack',
  'transfer.cancel',
  'transfer.error',
  'download.request',
  'download.metadata',
  'download.complete',
  'error',
] as const;

export function expectedFrameClassForInnerType(
  innerType: string | undefined,
): 'control' | 'content' | undefined {
  if (!innerType) return undefined;
  if ((CONTENT_INNER_MESSAGE_TYPES as readonly string[]).includes(innerType)) return 'content';
  if ((CONTROL_INNER_MESSAGE_TYPES as readonly string[]).includes(innerType)) return 'control';
  return undefined;
}

export function assertFrameClassMatchesInner(
  frameClass: 'control' | 'content',
  innerType: string | undefined,
): void {
  const expected = expectedFrameClassForInnerType(innerType);
  if (!expected) {
    throw new RemoteProtocolError(
      'INVALID_FRAME',
      innerType ? `unknown inner message type: ${innerType}` : 'inner message type is required',
      { reason: innerType ? 'unknown_inner_type' : 'frame_class_mismatch' },
    );
  }
  if (frameClass !== expected) {
    throw new RemoteProtocolError(
      'INVALID_FRAME',
      `frame_class ${frameClass} does not match inner type ${innerType}`,
      { reason: 'frame_class_mismatch' },
    );
  }
}

export function parseCommandRequest(value: unknown, now: number): CommandRequest {
  const command = parseClosed(commandRequestSchema, value);
  validateCommandIdentity(command.command_id, command.created_at, now);
  parseRemoteMethodParams(command.method, command.params);
  return command;
}

export interface HelloNegotiationInput {
  peer_min_minor: number;
  peer_max_minor: number;
  local_min_minor?: number;
  local_max_minor?: number;
  peer_capabilities: string[];
  local_capabilities?: readonly string[];
}

export function negotiateHello(input: HelloNegotiationInput): {
  negotiated_minor_version: number;
  negotiated_capabilities: Array<(typeof WIRE_FEATURES)[number]>;
} {
  const localMin = input.local_min_minor ?? REMOTE_MIN_MINOR_VERSION;
  const localMax = input.local_max_minor ?? REMOTE_MAX_MINOR_VERSION;
  const overlapMin = Math.max(localMin, input.peer_min_minor);
  const overlapMax = Math.min(localMax, input.peer_max_minor);
  if (overlapMin > overlapMax) {
    throw new RemoteProtocolError('PROTOCOL_VERSION_UNSUPPORTED', 'minor version ranges do not overlap.');
  }
  const localCaps = new Set(input.local_capabilities ?? WIRE_FEATURES);
  const negotiated = WIRE_FEATURES.filter((id) => (
    localCaps.has(id) && input.peer_capabilities.includes(id)
  ));
  return {
    negotiated_minor_version: overlapMax,
    negotiated_capabilities: negotiated,
  };
}

export interface SnapshotPartAssembly {
  snapshot_id: string;
  host_generation: string;
  revision: string;
  event_sequence: number;
  part_total: number;
  payload_size: number;
  payload_sha256: string;
  parts: Map<number, string>;
}

export function createSnapshotPartAssembly(part: StateSnapshotPart): SnapshotPartAssembly {
  if (part.part_index >= part.part_total) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot part index is out of range.');
  }
  const parts = new Map<number, string>();
  parts.set(part.part_index, part.bytes);
  return {
    snapshot_id: part.snapshot_id,
    host_generation: part.host_generation,
    revision: part.revision,
    event_sequence: part.event_sequence,
    part_total: part.part_total,
    payload_size: part.payload_size,
    payload_sha256: part.payload_sha256,
    parts,
  };
}

export function addSnapshotPart(assembly: SnapshotPartAssembly, part: StateSnapshotPart): void {
  if (
    part.snapshot_id !== assembly.snapshot_id
    || part.host_generation !== assembly.host_generation
    || part.revision !== assembly.revision
    || part.event_sequence !== assembly.event_sequence
    || part.part_total !== assembly.part_total
    || part.payload_size !== assembly.payload_size
    || part.payload_sha256 !== assembly.payload_sha256
  ) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot part metadata conflict.');
  }
  if (part.part_index >= assembly.part_total) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot part index is out of range.');
  }
  const existing = assembly.parts.get(part.part_index);
  if (existing && existing !== part.bytes) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot part duplicate conflict.');
  }
  assembly.parts.set(part.part_index, part.bytes);
}

export async function finalizeSnapshotParts(assembly: SnapshotPartAssembly): Promise<RemoteStateSnapshot> {
  if (assembly.parts.size !== assembly.part_total) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot parts are incomplete.');
  }
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < assembly.part_total; index += 1) {
    const encoded = assembly.parts.get(index);
    if (!encoded) {
      throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot part is missing.');
    }
    chunks.push(base64UrlToBytes(encoded));
  }
  const payload = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (payload.byteLength !== assembly.payload_size || payload.byteLength > MAX_SNAPSHOT_TOTAL_BYTES) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot payload size mismatch.');
  }
  const digest = await sha256Hex(payload);
  if (digest !== assembly.payload_sha256) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot payload hash mismatch.');
  }
  return parseClosed(remoteStateSnapshotSchema, JSON.parse(new TextDecoder().decode(payload)));
}

export async function splitSnapshotParts(
  snapshot: RemoteStateSnapshot,
  maxPartBytes: number,
): Promise<StateSnapshotPart[]> {
  const payload = new TextEncoder().encode(canonicalJson(snapshot));
  if (payload.byteLength > MAX_SNAPSHOT_TOTAL_BYTES) {
    throw new RemoteProtocolError('FRAME_TOO_LARGE', 'snapshot exceeds the assembly limit.');
  }
  const digest = await sha256Hex(payload);
  const partTotal = Math.max(1, Math.ceil(payload.byteLength / maxPartBytes));
  if (partTotal > MAX_SNAPSHOT_PARTS) {
    throw new RemoteProtocolError('FRAME_TOO_LARGE', 'snapshot requires too many parts.');
  }
  const parts: StateSnapshotPart[] = [];
  for (let index = 0; index < partTotal; index += 1) {
    const start = index * maxPartBytes;
    const bytes = payload.slice(start, start + maxPartBytes);
    parts.push(parseClosed(stateSnapshotPartSchema, {
      type: 'state.snapshot.part',
      snapshot_id: snapshot.snapshot_id,
      host_generation: snapshot.host_generation,
      revision: snapshot.revision,
      event_sequence: snapshot.event_sequence,
      part_index: index,
      part_total: partTotal,
      payload_size: payload.byteLength,
      payload_sha256: digest,
      bytes: bytesToBase64Url(bytes),
    }));
  }
  return parts;
}

export function applyStatePatch(
  current: { host_generation: string; revision: string; event_sequence: number },
  patch: StatePatch,
): { revision: string; event_sequence: number } {
  if (patch.host_generation !== current.host_generation) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'host generation changed.');
  }
  if (patch.base_revision !== current.revision) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'state patch base revision mismatch.');
  }
  if (patch.event_sequence !== current.event_sequence + 1) {
    throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'state patch event sequence gap.');
  }
  return {
    revision: patch.revision,
    event_sequence: patch.event_sequence,
  };
}

export const CONTENT_CHUNK_JSON_OVERHEAD_BYTES = 256;

export function contentChunkRawByteLimit(
  overheadBytes = CONTENT_CHUNK_JSON_OVERHEAD_BYTES,
): number {
  if (overheadBytes >= MAX_CONTENT_CHUNK_PLAINTEXT_BYTES) {
    throw new RemoteProtocolError('FRAME_TOO_LARGE', 'content chunk overhead exceeds the plaintext limit.');
  }
  return Math.floor((MAX_CONTENT_CHUNK_PLAINTEXT_BYTES - overheadBytes) * 3 / 4);
}

export function assertContentChunkLimit(bytes: string): void {
  if (utf8ByteLength(bytes) > MAX_CONTENT_CHUNK_PLAINTEXT_BYTES) {
    throw new RemoteProtocolError('FRAME_TOO_LARGE', 'content chunk exceeds 256 KiB.');
  }
}

export function assertInnerContentPlaintext(message: object): void {
  if (utf8ByteLength(JSON.stringify(message)) > MAX_CONTENT_CHUNK_PLAINTEXT_BYTES) {
    throw new RemoteProtocolError('FRAME_TOO_LARGE', 'content inner plaintext exceeds 256 KiB.');
  }
}

export function parseContentChunk(value: unknown): z.infer<typeof attachmentChunkSchema> {
  const chunk = parseClosed(attachmentChunkSchema, value);
  assertContentChunkLimit(chunk.bytes);
  return chunk;
}

export const REMOTE_PROTOCOL_NAME = REMOTE_PROTOCOL;
export const REMOTE_METHOD_LIST = REMOTE_METHODS;
export const BUSINESS_CAPABILITY_LIST = BUSINESS_CAPABILITY_IDS;
