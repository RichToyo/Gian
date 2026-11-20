/**
 * Remote-environment connectivity store: which paired Remote Control
 * environments the Host's controller relay is currently connected to. The
 * sidebar renders a globe badge for remote Sessions and flips it to the
 * disconnected glyph when their environment goes down.
 *
 * Module-level store (same shape as the schedule badge store in
 * use-schedules.ts): one lazy REST fetch serves every row, freshness rides
 * the Host's dedup'd `remote:environments` push plus a re-fetch on
 * `state_sync` (both dispatched by use-app-socket.ts).
 *
 * Unknown / not-hydrated environments report `undefined` and consumers MUST
 * treat that as connected — the disconnected glyph is never a guess.
 *
 * Settings › Remote reads the full list from the same store, so its statuses
 * follow the same pushes.
 */
import { useSyncExternalStore } from 'react';
import { remoteRequest, type RemoteEnvironment } from '../remote-environments.js';

const listeners = new Set<() => void>();
let connectedById: ReadonlyMap<string, boolean> = new Map();
/** The whole list, and whether the last REST fetch failed. */
let listing: { environments: RemoteEnvironment[] | null; failed: boolean } = { environments: null, failed: false };
let hydrated = false;
let flight: Promise<void> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

/** Socket `remote:environments` push — the Host's snapshot is canonical. */
export function applyRemoteEnvironmentsSnapshot(environments: RemoteEnvironment[]): void {
  connectedById = new Map(environments.map(environment => [environment.id, environment.connected]));
  listing = { environments, failed: false };
  hydrated = true;
  emit();
}

/** Lazy REST hydration + state_sync re-fetch. Keeps the last known map on
 *  failure — the badge is a hint, never a gate. */
export function refreshRemoteEnvironments(): Promise<void> {
  flight ??= (async () => {
    try {
      const result = await remoteRequest<{ environments: RemoteEnvironment[] }>('/environments');
      applyRemoteEnvironmentsSnapshot(Array.isArray(result.environments) ? result.environments : []);
    } catch {
      // Keep the last known map; Settings says the list could not be loaded.
      listing = { ...listing, failed: true };
      emit();
    } finally {
      flight = null;
    }
  })();
  return flight;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!hydrated) void refreshRemoteEnvironments();
  return () => { listeners.delete(listener); };
}

/** Connectivity of one Remote Control environment: `true`/`false` once the
 *  environment is known, `undefined` while unhydrated or unknown. */
export function useRemoteEnvironmentConnected(environmentId: string | undefined): boolean | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (hydrated && environmentId ? connectedById.get(environmentId) : undefined),
    () => undefined,
  );
}

/** Every paired environment, removed ones included, as last pushed or
 *  fetched (`null` until the first answer). */
export function useRemoteEnvironments(): { environments: RemoteEnvironment[] | null; failed: boolean } {
  return useSyncExternalStore(subscribe, () => listing, () => listing);
}

/** Test-only: drop hydrated state so each test re-fetches through its own
 *  mocked fetch router. */
export function __resetRemoteEnvironmentsForTest(): void {
  connectedById = new Map();
  listing = { environments: null, failed: false };
  hydrated = false;
  flight = null;
}
