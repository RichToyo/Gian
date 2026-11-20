import { isOfficialQuotaData, type OfficialQuotaAccount, type OfficialQuotaSnapshot } from '@gian/shared';
import { isProxyOfficialQuotaReadResult, type ProxyOfficialQuotaReadResult } from '@gian/proxy-protocol';

export interface OfficialQuotaBinding {
  source?: 'cli';
  agentId: string;
  pluginId: string;
  label: string;
  /** Host-derived nonsecret identity, changes on HOME/Runtime/auth generation. */
  scopeKey: string;
  installed: boolean;
  firstParty: boolean | null;
  eligibility: OfficialQuotaAccount['eligibility'];
  read?: (signal: AbortSignal) => Promise<Pick<OfficialQuotaAccount, 'windows' | 'balances'> | ProxyOfficialQuotaReadResult>;
}

export class QuotaReadError extends Error {
  constructor(readonly code: NonNullable<OfficialQuotaAccount['error']>, readonly retryAfterMs = 0) { super(code); }
}

type Cache = { value: OfficialQuotaAccount; retryAt: number; failures: number; authRevision?: string | null; excluded?: boolean };
export const OFFICIAL_QUOTA_INTERVAL_MS = 30 * 60_000;
/** Snapshot reads are passive. Production explicitly starts the background
 * scheduler after Runtime provisioning; UI visibility never drives queries. */
export class OfficialQuotaService {
  private cache = new Map<string, Cache>();
  private flights = new Map<string, Promise<void>>();
  private active = 0;
  private waiters: Array<() => void> = [];
  private lastAttempt = new Map<string, number>();
  private controllers = new Set<AbortController>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sweep: Promise<void> | null = null;
  private started = false;
  private closed = false;
  constructor(private readonly bindings: () => Promise<OfficialQuotaBinding[]>, private readonly now = Date.now,
    private readonly timeoutMs = 8_000) {}

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    const schedule = (delay: number) => {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.refreshDue().catch(() => {
          console.warn('[quota] background refresh could not load local accounts');
        }).finally(() => { if (!this.closed) schedule(60_000); });
      }, delay);
      this.timer.unref?.();
    };
    schedule(15_000);
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.controllers) controller.abort(new QuotaReadError('unavailable'));
    await Promise.allSettled([...this.flights.values(), ...(this.sweep ? [this.sweep] : [])]);
  }

  refreshDue(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.sweep) return this.sweep;
    const sweep = (async () => {
      const bindings = await this.bindings();
      const current = new Set(bindings.map(item => item.scopeKey));
      for (const key of this.lastAttempt.keys()) if (!current.has(key)) this.lastAttempt.delete(key);
      // Sequential polling keeps later accounts from spending their request
      // budget waiting behind slow CLI bootstraps. Manual reads still coalesce.
      for (const binding of bindings) {
        if (this.closed) break;
        await this.refresh(binding.agentId, { automatic: true });
      }
    })().finally(() => { if (this.sweep === sweep) this.sweep = null; });
    this.sweep = sweep;
    return sweep;
  }

  async snapshot(): Promise<OfficialQuotaSnapshot> {
    const bindings = (await this.bindings()).filter(item => item.installed && item.firstParty !== false);
    const current = new Set(bindings.map(item => item.scopeKey));
    for (const key of this.cache.keys()) if (!current.has(key)) this.cache.delete(key);
    const asOf = this.now();
    return { asOf, accounts: bindings.filter(binding => {
      const cache = this.cache.get(binding.scopeKey);
      return !cache?.excluded || this.expired(cache.value, asOf);
    }).map<OfficialQuotaAccount>(binding => {
      const entry = this.cache.get(binding.scopeKey);
      const cached = entry?.excluded ? undefined : entry?.value;
      if (cached && ['eligible', 'unverified'].includes(binding.eligibility)) {
        const hasData = cached.fetchedAt !== null;
        const expired = this.expired(cached, asOf) || cached.error !== null;
        return { ...cached, label: binding.label, agentIds: [binding.agentId],
          freshness: !hasData ? 'none' : expired ? 'stale' : 'fresh', status: this.flights.has(binding.scopeKey) ? 'loading'
            : cached.status === 'auth_required' || cached.status === 'unsupported' || !hasData ? cached.status : expired ? 'stale' : cached.status };
      }
      const empty = this.empty(binding);
      return this.flights.has(binding.scopeKey) ? { ...empty, status: 'loading' } : empty;
    }) };
  }

  async refresh(agentId: string, options: { automatic?: boolean } = {}): Promise<OfficialQuotaSnapshot> {
    if (this.closed) return this.snapshot();
    const binding = (await this.bindings()).find(item => item.agentId === agentId && item.installed && item.firstParty !== false);
    if (this.closed || !binding || !['eligible', 'unverified'].includes(binding.eligibility) || !binding.read) return this.snapshot();
    const existing = this.flights.get(binding.scopeKey);
    if (existing) { await existing; return this.snapshot(); }
    const cache = this.cache.get(binding.scopeKey);
    // Rate limits remain respected. A manual retry otherwise bypasses the
    // ordinary cache/backoff, including after the user signs in natively.
    if (cache?.value.error === 'rate_limited' && this.now() < cache.retryAt) return this.snapshot();
    if (options.automatic) {
      const last = this.lastAttempt.get(binding.scopeKey);
      if (cache?.value.status === 'auth_required'
        || (last !== undefined && this.now() - last < OFFICIAL_QUOTA_INTERVAL_MS)
        || (cache && this.now() < cache.retryAt)) return this.snapshot();
    }
    this.lastAttempt.set(binding.scopeKey, this.now());
    const flight = this.query(binding).finally(() => this.flights.delete(binding.scopeKey));
    this.flights.set(binding.scopeKey, flight);
    await flight;
    return this.snapshot();
  }

  private async query(binding: OfficialQuotaBinding): Promise<void> {
    const abort = new AbortController();
    this.controllers.add(abort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled: (() => void) | undefined;
    let release: (() => void) | undefined;
    let identityChecked = false;
    try {
      const response = await Promise.race([
        (async () => {
          release = await this.acquire(abort.signal);
          abort.signal.throwIfAborted();
          // Uninstall/account switch while queued must not start a stale request.
          const before = await this.bindings();
          abort.signal.throwIfAborted();
          if (!before.some(item => item.agentId === binding.agentId && item.scopeKey === binding.scopeKey
            && item.installed && item.firstParty !== false && ['eligible', 'unverified'].includes(item.eligibility))) return null;
          const value = await binding.read!(abort.signal);
          abort.signal.throwIfAborted();
          const after = await this.bindings();
          abort.signal.throwIfAborted();
          return after.some(item => item.agentId === binding.agentId && item.scopeKey === binding.scopeKey
            && item.installed && item.firstParty !== false) ? { value } : null;
        })(),
        new Promise<never>((_, reject) => {
          cancelled = () => reject(abort.signal.reason);
          abort.signal.addEventListener('abort', cancelled, { once: true });
          timer = setTimeout(() => abort.abort(new QuotaReadError('timeout')), this.timeoutMs);
        }),
      ]);
      if (response === null) return;
      const result = response.value;
      if (!result || typeof result !== 'object') throw new QuotaReadError('invalid_response');
      if ('status' in result) {
        if (!isProxyOfficialQuotaReadResult(result)) throw new QuotaReadError('invalid_response');
        if (result.source !== binding.source) throw new QuotaReadError('invalid_response');
        identityChecked = true;
        const prior = this.cache.get(binding.scopeKey);
        // Never carry one account's successful value into another account's error.
        if (!result.authRevision || result.authRevision !== prior?.authRevision) this.cache.delete(binding.scopeKey);
        if (result.status === 'error') throw new QuotaReadError(result.error!);
        const eligibility = result.status === 'ready' ? 'eligible'
          : result.status === 'auth_required' ? 'auth_required' : 'unsupported';
        if (result.status === 'auth_required' || result.status === 'unsupported') {
          console.warn(`[quota] ${binding.pluginId}: ${result.status} (${binding.source ?? 'runtime'})`);
        }
        this.cache.set(binding.scopeKey, { failures: 0, retryAt: 0,
          authRevision: result.authRevision, excluded: result.status === 'excluded',
          value: { ...this.empty(binding), eligibility, windows: result.windows, balances: result.balances,
            status: result.status === 'excluded' ? 'unsupported' : result.status,
            fetchedAt: this.now(), freshness: 'fresh', error: null },
        });
        return;
      }
      if (!isOfficialQuotaData(result)) throw new QuotaReadError('invalid_response');
      this.cache.set(binding.scopeKey, { failures: 0, retryAt: 0,
        value: { ...this.empty(binding), ...result, status: 'ready', fetchedAt: this.now(), freshness: 'fresh', error: null } });
    } catch (error) {
      if (this.closed) return;
      if (binding.firstParty === null && !identityChecked) this.cache.delete(binding.scopeKey);
      const prior = this.cache.get(binding.scopeKey);
      const failures = (prior?.failures ?? 0) + 1;
      const code = error instanceof QuotaReadError ? error.code : 'unavailable';
      console.warn(`[quota] ${binding.pluginId}: ${code} (${binding.source ?? 'runtime'})`);
      this.cache.set(binding.scopeKey, {
        failures, retryAt: code === 'auth_required' ? Number.POSITIVE_INFINITY
          : this.now() + Math.max(error instanceof QuotaReadError ? error.retryAfterMs : 0, Math.min(300_000, 5_000 * 2 ** Math.min(failures, 6))),
        authRevision: prior?.authRevision,
        value: { ...(code === 'auth_required' ? this.empty(binding) : prior?.value ?? this.empty(binding)), status: code === 'auth_required' ? 'auth_required' : prior?.value.fetchedAt != null ? 'stale' : 'error',
          error: code, freshness: prior?.value.fetchedAt != null ? 'stale' : 'none' },
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (cancelled) abort.signal.removeEventListener('abort', cancelled);
      this.controllers.delete(abort);
      abort.abort();
      release?.();
    }
  }

  private async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < 2) this.active += 1;
    else await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener('abort', cancelled); resolve(); };
      const cancelled = () => {
        const index = this.waiters.indexOf(ready);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      this.waiters.push(ready);
      signal.addEventListener('abort', cancelled, { once: true });
    });
    return () => {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }

  private empty(binding: OfficialQuotaBinding): OfficialQuotaAccount {
    return { accountKey: binding.scopeKey, agentIds: [binding.agentId], pluginId: binding.pluginId,
      ...(binding.source ? { source: binding.source } : {}),
      label: binding.label, eligibility: binding.eligibility,
      status: binding.eligibility === 'eligible' ? 'unverified' : binding.eligibility,
      fetchedAt: null, freshness: 'none', error: null, windows: [], balances: [] };
  }

  private expired(value: OfficialQuotaAccount, now: number): boolean {
    return value.fetchedAt === null || now - value.fetchedAt >= OFFICIAL_QUOTA_INTERVAL_MS
      || value.windows.some(window => window.resetAt !== null && window.resetAt <= now);
  }
}
