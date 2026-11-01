export type RemoteEntryDecision = 'checking' | 'app' | 'remote' | 'login';

/** Desktop GitHub login gates the rest of the app. Remote is the one surface
 * that may open before that login. A password-protected Host has no such bypass. */
export function remoteEntryDecision(input: {
  authStatus: 'checking' | 'login' | 'authenticated';
  githubDesktop: boolean;
  remoteChosen: boolean;
}): RemoteEntryDecision {
  if (input.authStatus === 'checking') return 'checking';
  if (input.authStatus === 'authenticated') return 'app';
  if (input.githubDesktop && input.remoteChosen) return 'remote';
  return 'login';
}

export function remoteEntryServerOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash || url.origin !== value.trim()) return null;
    if (url.protocol === 'https:') return url.origin;
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url.origin;
    return null;
  } catch {
    return null;
  }
}
