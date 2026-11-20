import type { TranslationPreferences } from '@gian/shared';

export interface TranslationKeyAccess {
  getTranslationKey(signal?: AbortSignal): Promise<string | null>;
  setTranslationKey(key: string | null): Promise<void>;
}

// /v1/models only proves visibility. Extend this intersection only when the
// model documentation confirms text input/output with Responses.
const TEXT_RESPONSE_MODELS = new Set([
  'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna',
]);

export async function listOpenAITextModels(keys: TranslationKeyAccess, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<string[]> {
  const key = await keys.getTranslationKey(signal);
  if (signal.aborted) throw new Error('Model lookup cancelled.');
  if (!key) throw new Error('Configure an OpenAI API key first.');
  let response: Response;
  try {
    response = await fetcher('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${key}` }, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
  } catch { throw new Error('Could not retrieve the OpenAI model catalog.'); }
  if (!response.ok) throw new Error(`OpenAI model catalog request failed (HTTP ${response.status}).`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !Array.isArray((data as { data?: unknown }).data)) {
    throw new Error('Invalid OpenAI model catalog.');
  }
  return [...new Set((data as { data: unknown[] }).data.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const id = (item as { id?: unknown }).id;
    return typeof id === 'string' && TEXT_RESPONSE_MODELS.has(id) ? [id] : [];
  }))].sort();
}

export function createOpenAITranslationModel(keys: Pick<TranslationKeyAccess, 'getTranslationKey'>, fetcher: typeof fetch = fetch) {
  return async (preferences: TranslationPreferences, prompt: string, signal: AbortSignal, instructions?: string): Promise<string> => {
    if (signal.aborted) throw new Error('Translation cancelled.');
    const key = await keys.getTranslationKey(signal);
    if (signal.aborted) throw new Error('Translation cancelled.');
    if (!key) throw new Error('Configure an OpenAI API key in translation settings.');
    const timeout = AbortSignal.timeout(120_000);
    let response: Response;
    try {
      response = await fetcher('https://api.openai.com/v1/responses', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, timeout]),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: preferences.model, input: prompt, store: false, ...(instructions ? { instructions } : {}) }),
      });
    } catch {
      if (signal.aborted) throw new Error('Translation cancelled.');
      if (timeout.aborted) throw new Error('Translation timed out.');
      throw new Error('Could not reach the OpenAI translation service.');
    }
    if (!response.ok) throw new Error(`OpenAI translation request failed (HTTP ${response.status}).`);
    let data: unknown;
    try { data = await response.json(); } catch {
      if (signal.aborted) throw new Error('Translation cancelled.');
      if (timeout.aborted) throw new Error('Translation timed out.');
      throw new Error('Invalid OpenAI translation response.');
    }
    if (signal.aborted) throw new Error('Translation cancelled.');
    if (!data || typeof data !== 'object') throw new Error('Invalid OpenAI translation response.');
    const result = data as { status?: unknown; output?: unknown };
    if (result.status !== 'completed' || !Array.isArray(result.output)) throw new Error('OpenAI translation did not complete.');
    const texts: string[] = [];
    for (const item of result.output) {
      if (!item || typeof item !== 'object' || item.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && typeof part === 'object' && part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
      }
    }
    if (!texts.length) throw new Error('OpenAI returned no translation.');
    return texts.join('\n');
  };
}
