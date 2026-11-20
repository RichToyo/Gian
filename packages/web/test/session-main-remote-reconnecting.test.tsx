import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/i18n/index.js';
import { SessionMain } from '../src/views/SessionMain.js';
import { sessionContractFixture } from './fixtures/ws-contract.js';
import { clearComposerCapabilityCaches } from '../src/components/composer/capabilities.js';

const remote = vi.hoisted(() => ({ status: { status: 'reconnecting' } as { status: string; reason?: string } }));

vi.mock('../src/api.js', () => {
  const never = () => new Promise<never>(() => {});
  return {
    loadChanged: never,
    loadProxyModels: never,
    loadProxyCapabilities: async () => ({ capabilities: {} }),
    loadSlashCommands: never,
    loadSessionSlashCommands: never,
    loadNativeConfig: never,
    loadAgents: async () => [],
    loadSessionTrace: never,
  };
});

vi.mock('../src/remote-environments.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/remote-environments.js')>(),
  remoteRequest: async (path: string) => {
    if (path.endsWith('/status')) return remote.status;
    return new Promise(() => {});
  },
}));

function mirroredSession(): Session {
  return sessionContractFixture({
    id: 'mirrored-session',
    status: 'done',
    remote_execution: {
      environment_id: 'studio', environment_name: 'Studio Mac', host_id: 'host',
      remote_session_id: 'remote', repository_id: 'repository', repository_name: 'gian',
    },
  });
}

function renderMirrored() {
  const onSend = vi.fn();
  const noop = vi.fn();
  render(
    <LocaleProvider locale="en">
      <SessionMain
        session={mirroredSession()}
        workspace={undefined}
        items={[]}
        hydrated
        pending={false}
        queue={[]}
        workingTreeId={null}
        branch={null}
        onSend={onSend}
        onSendSkill={noop}
        onStop={noop}
        onApprove={noop}
        onQueueAdd={noop}
        onQueueRemove={noop}
        onQueueUpdate={noop}
        onQueueClear={noop}
        onQueueSendNow={noop}
        onSteer={noop}
        onSetMode={noop}
        onSetModel={noop}
        onSetEffort={noop}
        onSetServiceTier={noop}
        onSetNativeConfig={noop}
        onReopen={noop}
        onShowChanges={noop}
        onShowLastTurnChanges={noop}
      />
    </LocaleProvider>,
  );
  return { onSend };
}

describe('mirrored session while its Host reconnects', () => {
  beforeEach(() => {
    localStorage.clear();
    clearComposerCapabilityCaches();
  });

  it('says it is reconnecting and keeps the composer usable, Send included', async () => {
    remote.status = { status: 'reconnecting' };
    const { onSend } = renderMirrored();

    expect(await screen.findByText(/Reconnecting to Studio Mac…/)).toBeVisible();
    expect(screen.queryByText(/Can’t reach Studio Mac/)).not.toBeInTheDocument();
    const editor = screen.getByRole('textbox');
    await waitFor(() => expect(editor).toHaveAttribute('contenteditable', 'true'));
    await userEvent.click(editor);
    await userEvent.keyboard('still here');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeEnabled();
    await userEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toBe('still here');
  });

  it('locks the composer once the Host is offline', async () => {
    remote.status = { status: 'offline' };
    const { onSend } = renderMirrored();

    expect(await screen.findByText(/Can’t reach Studio Mac right now/)).toBeVisible();
    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'false');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });
});
