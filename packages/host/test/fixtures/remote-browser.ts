/** Route identity discovery to the real fixture Server and isolate its pin. */
export function serverIdentityFetch(server: {
  publicOrigin: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}): typeof fetch {
  return (async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === server.publicOrigin && url.pathname === '/api/v1/server-identity') {
      return server.fetch(url.pathname, init);
    }
    return fetch(input, init);
  }) as typeof fetch;
}

export function installTestPinStorage(): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  };
}
