import type { Hono } from 'hono';
import { DEFAULT_TRANSLATION_PREFERENCES, OPENAI_TRANSLATION_AGENT_ID, isTranslationConfigured, normalizeComposerDocument } from '@gian/shared';
import type { Db } from '../../storage/db.js';
import { loadConfig } from '../../storage/config.js';
import type { TranslationService } from '../../translation/service.js';
import { listOpenAITextModels, type TranslationKeyAccess } from '../../translation/openai.js';

export function registerTranslationRoutes(app: Hono, db: Db, service: TranslationService, keys?: TranslationKeyAccess,
  onKeyChanged?: () => void): void {
  app.get('/api/translation/openai/models', async c => {
    if (!keys) return c.json({ error: 'Secure storage is unavailable.' }, 503);
    try { return c.json({ models: await listOpenAITextModels(keys, c.req.raw.signal) }); }
    catch { return c.json({ error: 'Could not retrieve the OpenAI model catalog.' }, 503); }
  });
  app.get('/api/translation/openai/key', async c => {
    c.header('Cache-Control', 'no-store');
    try {
      if (!keys) throw new Error('unavailable');
      return c.json({ configured: !!await keys.getTranslationKey() });
    } catch { return c.json({ error: 'Secure storage is unavailable.' }, 503); }
  });
  app.put('/api/translation/openai/key', async c => {
    try {
      if (!keys) return c.json({ error: 'Secure storage is unavailable.' }, 503);
      const body = await c.req.json();
      if (body.key !== null && (typeof body.key !== 'string' || !body.key.trim()
        || body.key.length > 4096 || /[\r\n]/.test(body.key))) return c.json({ error: 'Invalid API key.' }, 400);
      await keys.setTranslationKey(body.key === null ? null : body.key.trim());
      onKeyChanged?.();
      return c.json({ configured: body.key !== null });
    } catch { return c.json({ error: 'Could not update secure storage.' }, 503); }
  });
  app.use('/api/sessions/:sessionId/translation/*', async (c, next) => {
    if (!db.prepare('SELECT id FROM sessions WHERE id = ?').get(c.req.param('sessionId'))) {
      return c.json({ error: 'Session not found' }, 404);
    }
    await next();
  });
  app.get('/api/sessions/:sessionId/translation/state', c => c.json({
    enabled: service.enabled(c.req.param('sessionId')),
    revision: service.stateRevision(c.req.param('sessionId')),
    configRevision: service.configRevision(),
    results: service.list(c.req.param('sessionId')).filter(record => record.purpose === 'read' && !!record.sourceId),
    preferences: loadConfig(db).translation ?? DEFAULT_TRANSLATION_PREFERENCES,
    automatic: Object.fromEntries([...service.automatic].filter(([key]) => key.startsWith(`${c.req.param('sessionId')}:`))
      .map(([key, value]) => [key.slice(c.req.param('sessionId').length + 1), value])),
  }));
  app.patch('/api/sessions/:sessionId/translation/state', async c => {
    const body = await c.req.json();
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be boolean' }, 400);
    const preferences = loadConfig(db).translation ?? DEFAULT_TRANSLATION_PREFERENCES;
    if (body.enabled && !isTranslationConfigured(preferences)) {
      return c.json({ error: 'Choose a translation Agent, model and languages in Settings first.' }, 409);
    }
    if (body.enabled && preferences.agent_id === OPENAI_TRANSLATION_AGENT_ID) {
      const revision = service.configRevision();
      try {
        if (!keys || !await keys.getTranslationKey()) return c.json({ error: 'Configure an OpenAI API key first.' }, 409);
      } catch { return c.json({ error: 'Secure storage is unavailable.' }, 503); }
      if (revision !== service.configRevision()) return c.json({ error: 'Translation settings changed. Try again.' }, 409);
      if (!db.prepare('SELECT id FROM sessions WHERE id = ?').get(c.req.param('sessionId'))) return c.json({ error: 'Session not found' }, 404);
    }
    service.setEnabled(c.req.param('sessionId'), body.enabled);
    return c.json({ enabled: body.enabled });
  });
  app.post('/api/sessions/:sessionId/translation/requests', async c => {
    try {
      const body = await c.req.json();
      if (typeof body.requestId !== 'string' || body.requestId.length > 128 || !body.requestId
        || typeof body.text !== 'string' || (body.purpose !== 'send' && body.purpose !== 'read')
        || (body.sourceId !== undefined && (typeof body.sourceId !== 'string' || body.sourceId.length > 256))) {
        return c.json({ error: 'Invalid translation request' }, 400);
      }
      const document = body.document === undefined ? undefined : normalizeComposerDocument(body.document);
      if (document === null) return c.json({ error: 'Invalid translation document' }, 400);
      const result = await service.translate({
        sessionId: c.req.param('sessionId'), requestId: body.requestId,
        text: body.text, purpose: body.purpose, sourceId: body.sourceId, document,
      }, loadConfig(db).translation ?? { ...DEFAULT_TRANSLATION_PREFERENCES }, c.req.raw.signal);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Translation failed' }, 400);
    }
  });
  app.delete('/api/sessions/:sessionId/translation/requests/:requestId', c => {
    service.cancel(c.req.param('sessionId'), c.req.param('requestId'));
    return c.json({ ok: true });
  });
}
