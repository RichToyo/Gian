import { AgentLogo } from '../components/AgentLogo.js';
import { ICON, SvgIcon } from './icons.js';

/** Agent identity mark for panel rows: the real brand logo via the shared
 * AgentLogo (Host `/api/proxies/:id/logo` assets, light/dark via CSS), or the
 * app's existing generic bot geometry when the identity is unknown/mixed.
 * Never a colored dot. */
export function AgentMark({
  pluginId,
  size,
  className,
}: {
  pluginId: string | null;
  size: number;
  className?: string;
}) {
  if (!pluginId) {
    return (
      <span
        className={`mb-agent-generic${className ? ` ${className}` : ''}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <SvgIcon d={ICON.bot} size={Math.max(10, size - 2)} />
      </span>
    );
  }
  return <AgentLogo proxy={pluginId} size={size} className={className} />;
}

/* Bar tint for a known Agent identity, reusing the existing brand tokens from
 * tokens.css; anything unknown falls back to the accent. */
const AGENT_BAR_TOKENS: Record<string, string> = {
  claude: 'var(--claude)',
  cc: 'var(--claude)',
  'cc-proxy': 'var(--claude)',
  codex: 'var(--codex)',
  'codex-proxy': 'var(--codex)',
  kimi: 'var(--kimi)',
  'kimi-proxy': 'var(--kimi)',
  dsh: 'var(--dsh)',
  'dsh-proxy': 'var(--dsh)',
};

export function agentBarColor(pluginId: string | null): string {
  return (pluginId && AGENT_BAR_TOKENS[pluginId]) || 'var(--accent)';
}
