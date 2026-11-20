import { Fragment, useEffect, useRef, useState } from 'react';
import { DEFAULT_TRANSLATION_PREFERENCES, OPENAI_TRANSLATION_AGENT_ID, TRANSLATION_LANGUAGES, type ConfigOption, type SystemConfig, type UserAgentStatus } from '@gian/shared';
import { loadAgents } from '../api.js';
import { useT } from '../i18n/index.js';
import { translationCatalog, translationRequest } from '../operations/translation.js';
import { toast } from '../feedback.js';

function useSecureApiKey(endpoint: string, enabled: boolean) {
  const t = useT();
  const [key, setKey] = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [reload, setReload] = useState(0);
  const operation = useRef(0);
  const pending = useRef(false);
  const active = useRef(enabled);
  const mounted = useRef(false);
  active.current = enabled;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const current = ++operation.current;
    setKey(''); setConfigured(null); setError(''); setBusy(pending.current);
    if (enabled && !pending.current) {
      void translationRequest<{ configured: boolean }>(endpoint)
        .then(result => { if (current === operation.current) setConfigured(result.configured); })
        .catch(() => { if (current === operation.current) setError(t('translation.keyUnavailable')); });
    }
    return () => { operation.current += 1; };
  }, [enabled, endpoint, reload, t]);
  const update = async (next: string | null) => {
    if (pending.current) return;
    pending.current = true;
    const current = ++operation.current;
    setBusy(true); setError('');
    try {
      const result = await translationRequest<{ configured: boolean }>(endpoint, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: next }),
      });
      if (current === operation.current) {
        setConfigured(result.configured); setKey(''); setVersion(value => value + 1);
      }
    } catch {
      const message = t(next === null ? 'translation.keyRemoveFailed' : 'translation.keySaveFailed');
      if (current === operation.current) setError(message);
      else toast({ kind: 'error', message: `${t('translation.apiKey')}: ${message}` });
    } finally {
      pending.current = false;
      if (current === operation.current) setBusy(false);
      else if (mounted.current && active.current) setReload(value => value + 1);
    }
  };
  return { key, setKey, configured, error, busy, version, update };
}

function ApiKeyField({ label, state }: { label: string; state: ReturnType<typeof useSecureApiKey> }) {
  const t = useT();
  return <>
    <dt>{label}</dt>
    <dd className="translation-key-controls">
      <input className="input" type="password" autoComplete="off" aria-label={label} value={state.key} disabled={state.busy}
        onChange={event => state.setKey(event.target.value)} />
      <div className="translation-key-actions">
        <button className="btn sm secondary" type="button" aria-label={`${t('translation.saveKey')} ${label}`}
          disabled={!state.key.trim() || state.busy} onClick={() => void state.update(state.key)}>{t('translation.saveKey')}</button>
        {state.configured && <button className="btn sm secondary" type="button" aria-label={`${t('translation.removeKey')} ${label}`}
          disabled={state.busy} onClick={() => void state.update(null)}>{t('translation.removeKey')}</button>}
        {state.configured !== null && <span>{t(state.configured ? 'translation.keyConfigured' : 'translation.keyNotConfigured')}</span>}
      </div>
      {state.error && <p role="alert">{state.error}</p>}
    </dd>
  </>;
}

export function SettingsTranslation({ config, onPatch }: { config: SystemConfig; onPatch: (patch: Partial<SystemConfig>) => void }) {
  const t = useT();
  const value = config.translation ?? DEFAULT_TRANSLATION_PREFERENCES;
  const valueRef = useRef(value);
  valueRef.current = value;
  const [agents, setAgents] = useState<UserAgentStatus[]>([]);
  const [models, setModels] = useState<ConfigOption['choices']>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const providerOperation = useRef(0);
  const previousProvider = useRef(value.agent_id);
  if (previousProvider.current !== value.agent_id) {
    previousProvider.current = value.agent_id;
    providerOperation.current += 1;
  }
  const openAI = value.agent_id === OPENAI_TRANSLATION_AGENT_ID;
  const translationKey = useSecureApiKey('/api/translation/openai/key', openAI);
  useEffect(() => {
    let alive = true;
    const refreshAgents = () => {
      void loadAgents({ refresh: true })
        .then(items => { if (alive) setAgents(items.filter(agent => !agent.id.startsWith('remote:'))); })
        .catch(error => { if (alive) setError(String(error)); });
    };
    refreshAgents();
    window.addEventListener('focus', refreshAgents);
    return () => { alive = false; window.removeEventListener('focus', refreshAgents); };
  }, []);
  useEffect(() => {
    let alive = true;
    setModels([]); setError(''); setLoading(false);
    if (openAI) {
      if (!translationKey.configured || translationKey.busy) return;
      setLoading(true);
      void translationRequest<{ models: string[] }>('/api/translation/openai/models')
        .then(result => {
          if (!alive) return;
          setModels(result.models.map(id => ({ value: id, displayName: id })));
          if (!result.models.length) setError(t('translation.modelCatalogEmpty'));
        })
        .catch(() => { if (alive) setError(t('translation.modelCatalogError')); })
        .finally(() => { if (alive) setLoading(false); });
      return () => { alive = false; };
    }
    const agent = agents.find(agent => agent.id === value.agent_id);
    if (!agent) {
      if (value.agent_id) setError(t('translation.agentMissing'));
      return;
    }
    setLoading(true);
    void translationCatalog(agent.pluginId, agent.id).then(catalog => {
      if (!alive) return;
      if (!catalog.configOptions.some(option => option.id === 'gian.translation')) {
        setError(t('translation.unsupported')); return;
      }
      setModels(catalog.configOptions.find(option => option.role === 'model')?.choices ?? []);
    }).catch(error => {
      if (!alive) return;
      setError(String(error).includes('agent not found:') ? t('translation.agentMissing') : String(error));
      if (String(error).includes('agent not found:')) {
        void loadAgents({ refresh: true }).then(items => {
          if (!alive) return;
          const current = items.filter(item => !item.id.startsWith('remote:'));
          setAgents(previous => previous.length === current.length
            && previous.every((item, index) => item.id === current[index]?.id
              && item.ready === current[index]?.ready && item.enabled === current[index]?.enabled)
            ? previous : current);
        }).catch(() => undefined);
      }
    })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [agents, value.agent_id, openAI, translationKey.configured, translationKey.busy, translationKey.version, catalogAttempt, t]);
  return <>
    <h4 className="s2-sectiontitle">{t('translation.title')}</h4>
    <dl className="kv-grid translation-settings">
      {(['sending_language', 'reading_language'] as const).map(key => <Fragment key={key}>
        <dt>{t(`translation.${key}`)}</dt>
        <dd><select className="select" aria-label={t(`translation.${key}`)} value={value[key]}
          onChange={event => onPatch({ translation: { ...value, [key]: event.target.value } })}>
          {TRANSLATION_LANGUAGES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></dd>
      </Fragment>)}
      <dt>{t('translation.agent')}</dt>
      <dd><select className="select" aria-label={t('translation.agent')} value={value.agent_id}
        onChange={event => {
          const selectedId = event.target.value;
          const operation = ++providerOperation.current;
          if (!selectedId) {
            onPatch({ translation: { ...value, agent_id: '', model: '' } });
            return;
          }
          if (selectedId === OPENAI_TRANSLATION_AGENT_ID) {
            onPatch({ translation: { ...value, agent_id: selectedId, model: '' } });
            return;
          }
          void loadAgents({ refresh: true }).then(items => {
            if (operation !== providerOperation.current) return;
            const current = items.filter(agent => !agent.id.startsWith('remote:'));
            setAgents(current);
            if (!current.some(agent => agent.id === selectedId && agent.enabled !== false && agent.ready)) {
              setError(t('translation.agentMissing'));
              return;
            }
            onPatch({ translation: { ...valueRef.current, agent_id: selectedId, model: '' } });
          }).catch(error => { if (operation === providerOperation.current) setError(String(error)); });
        }}>
        <option value="">{t('translation.chooseAgent')}</option>
        <option value={OPENAI_TRANSLATION_AGENT_ID}>OpenAI API</option>
        {value.agent_id && !openAI && !agents.some(agent => agent.id === value.agent_id) && <option value={value.agent_id}>{t('translation.agentMissing')}</option>}
        {agents.map(agent => <option key={agent.id} value={agent.id} disabled={agent.enabled === false || !agent.ready}>{agent.name}</option>)}
      </select></dd>
      {openAI && <ApiKeyField label={t('translation.apiKey')} state={translationKey} />}
      <dt>{t('translation.model')}</dt>
      <dd><select className="select" aria-label={t('translation.model')} value={value.model} disabled={loading || !models?.length}
        onChange={event => onPatch({ translation: { ...value, model: event.target.value } })}>
        <option value="">{t(loading ? 'translation.loadingModels' : 'translation.chooseModel')}</option>
        {value.model && !models?.some(model => model.value === value.model) && <option value={value.model}>{value.model}</option>}
        {models?.map(model => <option key={String(model.value)} value={String(model.value)}>{model.displayName}</option>)}
      </select>{openAI && error && <button className="btn sm secondary" type="button"
        onClick={() => setCatalogAttempt(attempt => attempt + 1)}>{t('translation.retryModels')}</button>}</dd>
    </dl>
    {error && <p role="alert" className="translation-error">{error}</p>}
  </>;
}
