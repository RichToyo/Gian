/**
 * The Host picker (new session and take over) offers only environments this
 * Mac still uses: one removed in Settings › Remote stays listed there, under
 * Removed, and never here.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/i18n/index.js';
import { RemoteEnvironmentControl } from '../src/components/RemoteEnvironmentControl.js';
import { remoteRequest, type RemoteEnvironment } from '../src/remote-environments.js';
import { renderWithOperations } from './operation-test-utils.js';

vi.mock('../src/remote-environments.js', async () => ({
  ...await vi.importActual<typeof import('../src/remote-environments.js')>('../src/remote-environments.js'),
  remoteRequest: vi.fn(),
}));

function environment(id: string, name: string, overrides: Partial<RemoteEnvironment> = {}): RemoteEnvironment {
  return { id, name, host_id: 'host-' + id, server_origin: 'https://remote.example.com', pending: false,
    connected: true, status: 'connected', removed_at: null, last_seen_at: null, ...overrides };
}

it('never offers a removed environment as a Host', async () => {
  vi.mocked(remoteRequest).mockResolvedValue({ environments: [
    environment('11111111-1111-4111-8111-111111111111', 'Build Mac'),
    environment('22222222-2222-4222-8222-222222222222', 'Removed Mac',
      { connected: false, status: 'removed', removed_at: Date.now() }),
  ] });
  render(
    <LocaleProvider>
      <RemoteEnvironmentControl value="" onChange={() => {}}>{control => control}</RemoteEnvironmentControl>
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByTestId('ns-host-picker'));
  const popover = await screen.findByRole('dialog', { name: 'Host' });
  expect(await within(popover).findByRole('button', { name: /Build Mac/ })).toBeTruthy();
  expect(within(popover).queryByRole('button', { name: /Removed Mac/ })).toBeNull();
  expect(vi.mocked(remoteRequest)).toHaveBeenCalledWith('/environments');
});

it('says why connecting a Host failed: refused, unreachable or a busy Remote Server', async () => {
  vi.mocked(remoteRequest).mockResolvedValue({ environments: [] });
  const answers = [
    () => Response.json({ error: 'pairing_rejected', code: 'AUTH_REQUIRED' }, { status: 409 }),
    () => Response.json({ error: 'pairing_unreachable' }, { status: 502 }),
    () => Response.json({ error: 'pairing_rate_limited', retry_after_seconds: 27 }, { status: 429, headers: { 'retry-after': '27' } }),
    () => new Response('Internal Server Error', { status: 500 }),
  ];
  const posted: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posted.push(`${init?.method ?? 'GET'} ${typeof input === 'string' ? input : input instanceof URL ? input.href : input.url}`);
    return answers.shift()!();
  }) as typeof fetch;
  try {
    renderWithOperations(
      <LocaleProvider>
        <RemoteEnvironmentControl value="" onChange={() => {}}>{control => control}</RemoteEnvironmentControl>
      </LocaleProvider>,
    );
    fireEvent.click(screen.getByTestId('ns-host-picker'));
    const popover = await screen.findByRole('dialog', { name: 'Host' });
    fireEvent.click(within(popover).getByRole('button', { name: 'Connect Host' }));
    fireEvent.change(within(popover).getByLabelText('Remote Server URL'), { target: { value: 'https://remote.example.com' } });
    fireEvent.change(within(popover).getByLabelText('Host name'), { target: { value: 'Mac mini' } });
    fireEvent.change(within(popover).getByLabelText('Pairing code'), { target: { value: 'ABCD-EFGH' } });
    const connect = within(popover).getAllByRole('button', { name: 'Connect Host' }).find(button => button.className.includes('primary'))!;
    for (const message of [
      'The Remote Server refused this pairing. The code may have expired or already been used.',
      'Could not reach the Remote Server. Check the address and your connection, then try again.',
      'The Remote Server is busy. Try again in 27 seconds.',
      'Remote connection failed. Refresh status',
    ]) {
      await waitFor(() => expect(connect).toBeEnabled());
      fireEvent.click(connect);
      await waitFor(() => expect(within(popover).getByRole('alert').textContent).toBe(message));
    }
    expect(posted).toEqual(Array(4).fill('POST /api/remote/environments'));
  } finally {
    globalThis.fetch = original;
  }
});
