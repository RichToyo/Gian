/**
 * Settings › Remote — component tests over the fixture
 * `RemoteSettingsController` plus a stubbed /api/remote fetch for the
 * environments block. Covers the two scopes (Control this Gian / Control other Gian installs),
 * the enrollment dialog contract (three fields, no field notes, token never
 * retained), the enrolled-Server Host-code environment dialog, the merged
 * destructive disconnect, the Add-device grant dialog,
 * the confirmed revoke flow, and environment pair/remove.
 *
 * These are fixture/browser-layer tests only: they prove the UI state
 * branches against the typed contract, not the Host remote backend.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  DEFAULT_LAYOUT_PREFERENCES,
  DEFAULT_TERMINAL_PREFERENCES,
  DEFAULT_TOOL_PREFERENCES,
} from '@gian/shared';
import type { RemoteSettingsSnapshot, SystemConfig } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsBody } from '../src/components/SettingsBody.js';
import { SettingsRemotePage } from '../src/components/SettingsRemotePage.js';
import { Toaster } from '../src/components/Toaster.js';
import { GitHubAuthorizationHost } from '../src/components/GitHubAuthorizationHost.js';
import { __resetFeedback } from '../src/feedback.js';
import type { RemoteEnvironment } from '../src/remote-environments.js';
import {
  __resetRemoteEnvironmentsForTest, applyRemoteEnvironmentsSnapshot,
} from '../src/controllers/use-remote-environments.js';
import { createRemoteSettingsFixture } from '../src/remote-settings/fixture.js';
import type { RemoteSettingsFixture } from '../src/remote-settings/fixture.js';
import type { RemoteDeviceInfo, RemoteSettingsController } from '../src/remote-settings/types.js';
import { createRemoteSettingsController } from '../src/remote-settings/production.js';
import { renderWithOperations } from './operation-test-utils.js';

function renderRemote(fixture: RemoteSettingsController | null) {
  return renderWithOperations(
    <>
      <SettingsRemotePage controller={fixture} />
      <GitHubAuthorizationHost login="RichLogic" />
      <Toaster />
    </>,
  );
}

function device(overrides: Partial<RemoteDeviceInfo> = {}): RemoteDeviceInfo {
  return {
    id: 'device-1',
    name: 'iPhone 17',
    platform: 'iOS 26 · Safari',
    createdAt: Date.UTC(2026, 7, 30, 9, 0),
    lastSeenAt: Date.now() - 3 * 60_000,
    activeConnections: 1,
    revokeStatus: 'active',
    ...overrides,
  };
}

function environment(overrides: Partial<RemoteEnvironment> = {}): RemoteEnvironment {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Mac mini',
    host_id: '22222222-2222-4222-8222-222222222222',
    server_origin: 'https://remote.example.com',
    pending: false,
    connected: true,
    status: 'connected',
    removed_at: null,
    last_seen_at: null,
    ...overrides,
  };
}

/** Stub the /api/remote environment endpoints the page calls directly.
 *  Remove keeps the row as removed (the Host's soft delete); Restore brings
 *  it back. `fail` makes those two answer 500. Each pairing takes the next
 *  of `pairings` as its answer, while any are left. */
function stubEnvironments(initial: RemoteEnvironment[], fail = false, pairings: Array<() => Response> = []) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let environments = [...initial];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const path = new URL(url, 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    if (path === '/api/remote/controller/account/start' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { server_url: string };
      calls.push({ method, path, body });
      return Response.json({ account: { status: 'authorized', server_url: body.server_url,
        login: 'RichLogic', expires_at: Date.now() + 300_000 } });
    }
    if (path === '/api/remote/environments' && method === 'GET') {
      calls.push({ method, path });
      return Response.json({ environments });
    }
    if (path === '/api/remote/environments' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { server_url: string; code: string; name: string };
      calls.push({ method, path, body });
      const answer = pairings.shift();
      if (answer) return answer();
      const created = environment({ name: body.name });
      environments = [...environments, created];
      return Response.json({ environment: created });
    }
    const removeMatch = /^\/api\/remote\/environments\/([0-9a-f-]+)$/.exec(path);
    if (removeMatch && method === 'DELETE') {
      calls.push({ method, path });
      if (fail) return Response.json({ error: 'failed' }, { status: 500 });
      environments = environments.map(item => item.id === removeMatch[1]
        ? { ...item, status: 'removed', removed_at: Date.now(), connected: false } : item);
      return Response.json({ ok: true, environments });
    }
    const restoreMatch = /^\/api\/remote\/environments\/([0-9a-f-]+)\/restore$/.exec(path);
    if (restoreMatch && method === 'POST') {
      calls.push({ method, path });
      if (fail) return Response.json({ error: 'failed' }, { status: 500 });
      environments = environments.map(item => item.id === restoreMatch[1]
        ? { ...item, status: 'connecting', removed_at: null } : item);
      return Response.json({ ok: true, environments });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

beforeEach(() => {
  __resetFeedback();
  __resetRemoteEnvironmentsForTest();
});

describe('Settings › Remote — availability', () => {
  it('renders the unavailable state when no controller is wired', () => {
    renderRemote(null);
    expect(screen.getByTestId('settings-remote-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('settings-remote-enrollment')).toBeNull();
  });
});

describe('Settings › Remote — Control this Gian', () => {
  it.each([
    ['http://127.0.0.1:18787/', 'http://127.0.0.1:18787'],
    ['https://remote.example.com/', 'https://remote.example.com'],
    ['http://remote.example.com', null],
    ['https://secret@remote.example.com', null],
    ['https://remote.example.com/another-path', null],
  ])('only permits valid Server origins and never offers inline GitHub login: %s', async (url, origin) => {
    const fixture = createRemoteSettingsFixture();
    fixture.startAccountLogin = vi.fn(async () => {});
    renderRemote(fixture);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), { target: { value: url } });
    fireEvent.change(within(dialog).getByLabelText('Enrollment token'), { target: { value: 'fixture-token' } });
    const button = within(dialog).queryByRole('button', { name: 'Sign in to Remote with GitHub' });
    expect(button).toBeNull();
    expect(fixture.startAccountLogin).not.toHaveBeenCalled();
    const connect = within(dialog).getByRole('button', { name: 'Connect' });
    if (origin) expect(connect).toBeEnabled();
    else expect(connect).toBeDisabled();
  });

  it('submits Host enrollment once without starting GitHub authorization', async () => {
    const environments = stubEnvironments([]);
    const url = 'https://remote.example.com';
    let backend: RemoteSettingsSnapshot = {
      enrolled: false, account: null, host_id: null, host_name: null, server_url: null,
      public_url: null, connection: 'offline', last_heartbeat_at: null,
      server_identity_fingerprint: null, pending_identity_fingerprint: null,
      identity_changed_at: null, pairing: null, pending_pairings: [], devices: [],
    };
    const enrollments: unknown[] = [];
    const requests: string[] = [];
    const fetchFn: typeof fetch = async (path, init) => {
      requests.push(String(path));
      if (String(path) === '/api/remote/enroll') {
        enrollments.push(JSON.parse(String(init?.body)));
        backend = { ...backend, enrolled: true, host_id: 'host', host_name: 'Studio Mac', server_url: url,
          server_identity_fingerprint: 'a'.repeat(64), connection: 'online' };
      }
      return Response.json(backend);
    };
    const controller = createRemoteSettingsController({ fetchFn, pollIntervalMs: 60_000 });
    const view = renderRemote(controller);
    try {
      await act(async () => { await controller.refresh?.(); });
      fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
      const dialog = screen.getByRole('dialog', { name: 'Connect Remote Server' });
      fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), { target: { value: url } });
      fireEvent.change(within(dialog).getByLabelText('Machine name'), { target: { value: 'Studio Mac' } });
      const token = within(dialog).getByLabelText('Enrollment token') as HTMLInputElement;
      fireEvent.change(token, { target: { value: 'first-secret' } });
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' })); });
      expect(token.value).toBe('');
      expect(enrollments).toEqual([
        { server_url: url, enrollment_token: 'first-secret', host_name: 'Studio Mac' },
      ]);
      expect(requests.some(path => path.startsWith('/api/remote/account/'))).toBe(false);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByTestId('remote-link-status').textContent).toBe('Online');
      expect(document.body.textContent).not.toMatch(/first-secret|fresh-secret/);
    } finally { view.unmount(); controller.dispose?.(); environments.restore(); }
  });

  it('does not independently poll an account from inside the enrollment form', async () => {
    vi.useFakeTimers();
    const environments = stubEnvironments([]);
    const fixture = createRemoteSettingsFixture();
    const state = fixture.getState();
    state.account = { status: 'pending', server_url: 'https://remote.example.com', user_code: 'HOST-CODE',
      verification_uri: 'https://github.com/login/device', expires_at: Date.now() + 300_000, interval_seconds: 1 };
    fixture.startAccountLogin = vi.fn(async () => {});
    fixture.pollAccountLogin = vi.fn(async () => {});
    const view = renderRemote(fixture);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), { target: { value: 'https://remote.example.com' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(fixture.pollAccountLogin).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(fixture.pollAccountLogin).not.toHaveBeenCalled();
    } finally { view.unmount(); environments.restore(); vi.useRealTimers(); }
  });

  it('not enrolled shows only the connect button; the dialog holds the three fields and no field notes', () => {
    renderRemote(createRemoteSettingsFixture());
    expect(screen.queryByTestId('remote-account-login')).toBeNull();
    expect(screen.queryByRole('button', { name: /GitHub/ })).toBeNull();
    expect(screen.queryByLabelText('Enrollment token')).toBeNull();
    expect(screen.queryByTestId('settings-remote-devices')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Remote Server' });
    expect(within(dialog).getByLabelText('Remote Server URL')).toBeTruthy();
    expect(within(dialog).getByLabelText('Enrollment token')).toBeTruthy();
    expect(within(dialog).getByLabelText('Machine name')).toBeTruthy();
    // No under-field hint text anywhere in the dialog.
    expect(dialog.querySelector('.hint')).toBeNull();
  });

  it('the token "i" tooltip explains how to obtain a token and links the HTTPS registration page', () => {
    renderRemote(createRemoteSettingsFixture());
    fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Remote Server' });
    fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), {
      target: { value: 'https://remote.example.com' },
    });
    const info = within(dialog).getByRole('note', { name: 'How do I get an enrollment token?' });
    expect(info.textContent).toContain('gian-remote-server enrollment create');
    expect(info.textContent).toContain('docker compose exec remote gian-remote-server enrollment create');
    expect(info.textContent).toContain('not the administrator key');
    const link = within(info).getByRole('link', { name: 'Open Host registration' });
    expect(link).toHaveAttribute('href', 'https://remote.example.com/enrollment');

    fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), {
      target: { value: 'https://secret@remote.example.com' },
    });
    expect(within(info).queryByRole('link')).toBeNull();
  });

  it('enrolls with an optional machine name: token is cleared immediately and never echoed', async () => {
    const fixture = createRemoteSettingsFixture();
    const enroll = vi.spyOn(fixture, 'enroll');
    renderRemote(fixture);

    fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Remote Server' });
    fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), {
      target: { value: 'https://remote.example.com' },
    });
    fireEvent.change(within(dialog).getByLabelText('Machine name'), { target: { value: '  Home Mac  ' } });
    const tokenInput = within(dialog).getByLabelText('Enrollment token') as HTMLInputElement;
    fireEvent.change(tokenInput, { target: { value: 'one-time-secret-token' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));

    // Cleared synchronously on submit — the pending UI must not retain it.
    expect(tokenInput.value).toBe('');
    expect(enroll).toHaveBeenCalledWith({
      serverUrl: 'https://remote.example.com',
      enrollmentToken: 'one-time-secret-token',
      hostName: 'Home Mac',
    });

    await screen.findByTestId('remote-link-status');
    expect(screen.getByTestId('remote-link-status').textContent).toBe('Online');
    expect(screen.getByText('https://remote.example.com')).toBeTruthy();
    expect(document.body.textContent).not.toContain('one-time-secret-token');
  });

  it('omits the machine name when the field is left empty', async () => {
    const fixture = createRemoteSettingsFixture();
    const enroll = vi.spyOn(fixture, 'enroll');
    renderRemote(fixture);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Remote Server' });
    fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), {
      target: { value: 'https://remote.example.com' },
    });
    fireEvent.change(within(dialog).getByLabelText('Enrollment token'), { target: { value: 't' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(enroll).toHaveBeenCalledWith({
      serverUrl: 'https://remote.example.com',
      enrollmentToken: 't',
    });
    await screen.findByTestId('remote-link-status');
  });

  it('keeps the dialog open with the canonical error when enrollment fails', async () => {
    const fixture = createRemoteSettingsFixture();
    fixture.failNextEnroll('invalid enrollment token');
    renderRemote(fixture);

    fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Remote Server' });
    fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), {
      target: { value: 'https://remote.example.com' },
    });
    fireEvent.change(within(dialog).getByLabelText('Enrollment token'), { target: { value: 'bad' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));

    const error = await within(dialog).findByRole('alert');
    expect(error.textContent).toContain('Connection failed');
    expect(error.textContent).toContain('invalid enrollment token');
    expect(fixture.getState().enrollment.kind).toBe('connect-failed');
  });

  it('edits the remote computer name without re-enrollment', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    const rename = vi.fn(fixture.setHostName!);
    fixture.setHostName = rename;
    renderRemote(fixture);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Host Name' });
    fireEvent.change(input, { target: { value: '  Home Mac  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await screen.findByText('Home Mac');
    expect(rename).toHaveBeenCalledWith('Home Mac');
    expect(fixture.getState().enrollment.kind).toBe('connected');
  });

  it('one merged disconnect: confirmed once, it wipes enrollment and devices', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true, devices: [device()] });
    const disable = vi.spyOn(fixture, 'disableRemote');
    renderRemote(fixture);

    // There is exactly one destructive action — no second "disable" variant.
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(fixture.getState().enrollment.kind).toBe('connected');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('removes the local enrollment');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(fixture.getState().enrollment.kind).toBe('not-enrolled'));
    expect(disable).toHaveBeenCalledTimes(1);
    expect(fixture.getState().devices).toHaveLength(0);
    // Back to the connect button; the device card is gone with the enrollment.
    expect(await screen.findByRole('button', { name: 'Connect Remote Server' })).toBeTruthy();
    expect(screen.queryByTestId('settings-remote-devices')).toBeNull();
  });

  it('blocks on server identity change and requires explicit confirmation', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);

    act(() => fixture.simulateServerIdentityChange());
    const warning = await screen.findByTestId('remote-identity-changed');
    expect(warning.textContent).toContain('Server identity changed');
    const fingerprints = [...warning.querySelectorAll('.rs-fingerprint')].map(el => el.textContent);
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);

    fireEvent.click(screen.getByRole('button', { name: 'Trust new identity' }));
    await waitFor(() => expect(fixture.getState().enrollment.kind).toBe('connected'));
  });

  it('rejecting an identity change keeps the Host disconnected', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);

    act(() => fixture.simulateServerIdentityChange());
    await screen.findByTestId('remote-identity-changed');
    fireEvent.click(screen.getByRole('button', { name: 'Keep disconnected' }));
    await waitFor(() => expect(fixture.getState().enrollment.kind).toBe('disconnected'));
  });
});

describe('Settings › Remote — devices', () => {
  async function createGrant(fixture: RemoteSettingsFixture) {
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(fixture.getState().pairing.kind).toBe('awaiting-claim'));
  }

  it('Add opens the grant dialog with one QR + one Crockford short code + countdown', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);
    await createGrant(fixture);

    const dialog = screen.getByRole('dialog', { name: 'Add' });
    const code = within(dialog).getByTestId('pairing-short-code').textContent ?? '';
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(within(dialog).getByTestId('pairing-qr').querySelector('svg')).toBeTruthy();
    expect(within(dialog).getByTestId('pairing-countdown').textContent ?? '').toMatch(/^[45]:[0-5]\d$/);
  });

  it('copies the exact QR invitation with a selectable fallback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);
    try {
      await createGrant(fixture);
      const pairing = fixture.getState().pairing;
      if (pairing.kind !== 'awaiting-claim') throw new Error('expected unclaimed invitation');
      const link = screen.getByRole('textbox', { name: 'Pairing link' }) as HTMLInputElement;
      expect(link.value).toBe(pairing.qrPayload);
      expect(link.readOnly).toBe(true);
      expect(new URL(link.value).hash).toContain('nonce=');
      fireEvent.click(screen.getByRole('button', { name: 'Copy pairing link' }));
      await screen.findByText('Pairing link copied.');
      expect(writeText).toHaveBeenCalledWith(pairing.qrPayload);
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('claim shows the local confirmation; Allow consumes the grant and lists the device', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);
    await createGrant(fixture);

    act(() => fixture.simulateClaim({
      deviceName: 'Pixel 10',
      browser: 'Chrome',
      os: 'Android 16',
      networkOrigin: 'Berlin · 85.214.x.x',
    }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Confirm this device?')).toBeTruthy();
    expect(within(dialog).getByText('Pixel 10')).toBeTruthy();
    expect(within(dialog).getByText('Chrome')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow device' }));
    await waitFor(() => expect(fixture.getState().pairing.kind).toBe('consumed'));
    expect(fixture.getState().devices.map(d => d.name)).toContain('Pixel 10');
  });

  it('Reject is an explicit command and leaves no device behind', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);
    await createGrant(fixture);

    act(() => fixture.simulateClaim());
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(fixture.getState().pairing.kind).toBe('rejected'));
    expect(fixture.getState().devices).toHaveLength(0);
  });

  it('the expired branch offers a fresh grant in place', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);
    await createGrant(fixture);

    act(() => fixture.simulateExpire());
    const dialog = screen.getByRole('dialog', { name: 'Add' });
    expect(within(dialog).getByText(/grant expired/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate new code' }));
    await waitFor(() => expect(fixture.getState().pairing.kind).toBe('awaiting-claim'));
  });

  it('a connected device row shows its name, stable short id, status, Rename and Revoke', () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true, devices: [device()] });
    renderRemote(fixture);
    const row = screen.getByTestId('remote-device-device-1');
    expect(row.textContent).toContain('iPhone 17');
    expect(within(row).getByText('#DEVICE1').textContent).toBe('#DEVICE1');
    expect(screen.getByTestId('remote-device-status-device-1').textContent)
      .toContain('Connected · last seen');
    expect(within(row).getByRole('button', { name: 'Rename' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: 'Revoke' })).toBeTruthy();
    // The old metadata (platform, created, connections, audit) stays out.
    expect(row.textContent).not.toContain('iOS 26 · Safari');
    expect(row.textContent).not.toContain('Created');
    expect(within(row).queryByRole('button', { name: 'Recent remote activity' })).toBeNull();
  });

  it('distinguishes identical labels with stable short ids and keeps offline devices operable', () => {
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    const fixture = createRemoteSettingsFixture({
      enrolled: true,
      devices: [
        device({ id: first, name: 'iPhone · Safari', activeConnections: 0 }),
        device({ id: second, name: 'iPhone · Safari', activeConnections: 0 }),
      ],
    });
    renderRemote(fixture);
    const firstRow = screen.getByTestId(`remote-device-${first}`);
    const secondRow = screen.getByTestId(`remote-device-${second}`);
    expect(within(firstRow).getByText('#11111111')).toBeTruthy();
    expect(within(secondRow).getByText('#22222222')).toBeTruthy();
    expect(within(firstRow).getByText('Not connected')).toBeTruthy();
    expect(within(secondRow).getByText('Not connected')).toBeTruthy();
    expect(within(firstRow).getByRole('button', { name: 'Rename' })).toBeEnabled();
    expect(within(secondRow).getByRole('button', { name: 'Revoke' })).toBeEnabled();
  });

  it('renames only the local display label, validates input, and preserves identity and authorization', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true, devices: [device()] });
    const rename = vi.spyOn(fixture, 'renameDevice');
    const revoke = vi.spyOn(fixture, 'revokeDevice');
    const view = renderRemote(fixture);
    const row = screen.getByTestId('remote-device-device-1');
    fireEvent.click(within(row).getByRole('button', { name: 'Rename' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename' });
    const input = within(dialog).getByLabelText('Device name');
    fireEvent.change(input, { target: { value: 'bad\u202Ename' } });
    expect(within(dialog).getByRole('button', { name: 'Save name' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '  My iPhone  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));

    await screen.findByText('My iPhone');
    expect(rename).toHaveBeenCalledWith('device-1', 'My iPhone');
    expect(revoke).not.toHaveBeenCalled();
    expect(fixture.getState().devices[0]).toMatchObject({
      id: 'device-1', name: 'My iPhone', revokeStatus: 'active', activeConnections: 1,
    });
    expect(screen.getByText('#DEVICE1').textContent).toBe('#DEVICE1');
    view.unmount();
    renderRemote(fixture);
    expect(screen.getByTestId('remote-device-device-1').textContent).toContain('My iPhone');
  });

  it('revoke requires the danger confirm, then reports pending — never premature completion', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true, devices: [device()] });
    renderRemote(fixture);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(fixture.getState().devices[0]!.revokeStatus).toBe('active');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('iPhone 17');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() =>
      expect(fixture.getState().devices[0]!.revokeStatus).toBe('pending-reconciliation'),
    );
    expect(screen.getByTestId('remote-device-status-device-1').textContent)
      .toBe('Revoked locally — Server reconciliation pending');

    act(() => fixture.simulateRevokeSettled('device-1'));
    await waitFor(() =>
      expect(screen.queryByTestId('remote-device-device-1')).toBeNull(),
    );
    expect(screen.getByText('No devices paired yet.')).toBeTruthy();
  });

  it('hides already-revoked records but keeps pending reconciliation visible', () => {
    const fixture = createRemoteSettingsFixture({
      enrolled: true,
      devices: [
        device({ id: 'revoked', name: 'Old phone', revokeStatus: 'revoked' }),
        device({ id: 'pending', name: 'Pending phone', revokeStatus: 'pending-reconciliation' }),
      ],
    });
    renderRemote(fixture);

    expect(screen.queryByText('Old phone')).toBeNull();
    expect(screen.getByText('Pending phone')).toBeTruthy();
    expect(screen.getByTestId('remote-device-status-pending').textContent)
      .toBe('Revoked locally — Server reconciliation pending');
    const pendingRow = screen.getByTestId('remote-device-pending');
    expect(within(pendingRow).getByRole('button', { name: 'Rename' })).toBeDisabled();
    expect(within(pendingRow).getByRole('button', { name: 'Revoking…' })).toBeDisabled();
  });
});

describe('Settings › Remote — Control other Gian installs', () => {
  it('lists environments with name and status; remove keeps them under Removed, and Restore brings them back', async () => {
    const stub = stubEnvironments([environment()]);
    renderRemote(createRemoteSettingsFixture());
    try {
      expect(await screen.findByText('Mac mini')).toBeTruthy();
      expect(screen.getByText('Connected')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(dialog.textContent).toContain('Its sessions stay here as read-only history');
      expect(dialog.textContent).toContain('nothing is unpaired on the remote Host');
      expect(dialog.textContent).toContain('Restore under Removed brings it back');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(stub.calls.some(call => call.method === 'DELETE'
        && call.path === '/api/remote/environments/11111111-1111-4111-8111-111111111111')).toBe(true));
      const removed = await screen.findByTestId('remote-environments-removed');
      expect(within(removed).getByText('Mac mini')).toBeTruthy();
      expect(within(removed).getByText(/sessions kept as read-only history/)).toBeTruthy();
      expect(screen.getByText('No other Gian connected yet.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();

      fireEvent.click(within(removed).getByRole('button', { name: 'Restore' }));
      await waitFor(() => expect(screen.queryByTestId('remote-environments-removed')).toBeNull());
      expect(stub.calls.some(call => call.method === 'POST'
        && call.path === '/api/remote/environments/11111111-1111-4111-8111-111111111111/restore')).toBe(true);
      expect(screen.getByText('Connecting…')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    } finally {
      stub.restore();
    }
  });

  it('shows a failed Remove or Restore instead of swallowing it', async () => {
    const stub = stubEnvironments([environment(), environment({ id: '33333333-3333-4333-8333-333333333333',
      name: 'Old Mac', status: 'removed', removed_at: Date.now() - 60_000, connected: false })], true);
    renderRemote(createRemoteSettingsFixture());
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
      expect((await screen.findByTestId('remote-environment-error')).textContent).toBe('Could not remove Mac mini. Try again.');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled());

      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
      await waitFor(() => expect(screen.getByTestId('remote-environment-error').textContent)
        .toBe('Could not restore Old Mac. Try again.'));
      expect(within(screen.getByTestId('remote-environments-removed')).getByText('Old Mac')).toBeTruthy();
    } finally {
      stub.restore();
    }
  });

  it('shows each status from the Host and follows its live pushes', async () => {
    const id = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`;
    const stub = stubEnvironments([
      environment({ id: id(1), name: 'Idle Mac', status: 'idle', connected: false }),
      environment({ id: id(2), name: 'Pending Mac', status: 'pending', pending: true, connected: false,
        last_error: { status: 'auth_required', reason: 'pairing' } }),
      environment({ id: id(3), name: 'Gone Mac', status: 'offline', connected: false, last_seen_at: Date.now() - 5 * 60_000,
        last_error: { status: 'auth_required', reason: 'server_identity' } }),
    ]);
    renderRemote(createRemoteSettingsFixture());
    try {
      expect((await screen.findByTestId(`remote-environment-status-${id(1)}`)).textContent).toBe('No active sessions');
      expect(screen.getByTestId(`remote-environment-status-${id(2)}`).textContent).toBe('Pending confirmation');
      expect(screen.getByTestId(`remote-environment-status-${id(3)}`).textContent).toBe('Offline · last seen 5m ago');
      expect(within(screen.getByTestId(`remote-environment-${id(3)}`)).getByText(/presents a different identity/)).toBeTruthy();
      expect(within(screen.getByTestId(`remote-environment-${id(2)}`)).queryByText(/pairing/)).toBeNull();

      // The Host's remote:environments push (applied by the app socket).
      act(() => applyRemoteEnvironmentsSnapshot([
        environment({ id: id(1), name: 'Idle Mac', status: 'connecting', connected: false }),
        environment({ id: id(2), name: 'Pending Mac', status: 'connected' }),
        environment({ id: id(3), name: 'Gone Mac', status: 'reconnecting', connected: false, last_seen_at: Date.now() - 20_000,
          last_error: { status: 'offline' } }),
      ]));
      expect(screen.getByTestId(`remote-environment-status-${id(1)}`).textContent).toBe('Connecting…');
      expect(screen.getByTestId(`remote-environment-status-${id(2)}`).textContent).toBe('Connected');
      // A brief drop being restored is not Offline.
      expect(screen.getByTestId(`remote-environment-status-${id(3)}`).textContent).toBe('Reconnecting…');
      expect(screen.queryByText(/presents a different identity/)).toBeNull();
    } finally {
      stub.restore();
    }
  });

  it('disables adding another Gian until this Mac is enrolled, while keeping the existing list available', async () => {
    const stub = stubEnvironments([environment()]);
    renderRemote(createRemoteSettingsFixture());
    try {
      expect(await screen.findByText('Mac mini')).toBeTruthy();
      const connect = screen.getByRole('button', { name: 'Connect' });
      expect(connect).toBeDisabled();
      expect(screen.getByText(/Connect this Gian to a Remote Server first/)).toBeTruthy();
      fireEvent.click(connect);
      expect(screen.queryByRole('dialog', { name: 'Connect another Gian' })).toBeNull();
      expect(stub.calls.some(call => call.method === 'POST' && call.path === '/api/remote/environments')).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it('uses only a Host pairing code and optional name with the fixed enrolled Server origin', async () => {
    const stub = stubEnvironments([]);
    renderRemote(createRemoteSettingsFixture({ enrolled: true }));
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
      const dialog = screen.getByRole('dialog', { name: 'Connect another Gian' });
      expect(within(dialog).getByText('https://remote.example.com')).toBeTruthy();
      expect(within(dialog).queryByLabelText('Remote Server URL')).toBeNull();
      expect(within(dialog).getAllByRole('textbox')).toHaveLength(2);
      expect(within(dialog).queryByTestId('pairing-qr')).toBeNull();
      expect(within(dialog).queryByLabelText('Pairing link')).toBeNull();
      fireEvent.change(within(dialog).getByLabelText('Host pairing code'), { target: { value: 'ABCD-EFGH' } });
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Mac mini' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));

      await waitFor(() => expect(stub.calls.some(call => call.method === 'POST' && call.path === '/api/remote/environments')).toBe(true));
      const post = stub.calls.find(call => call.method === 'POST' && call.path === '/api/remote/environments')!;
      expect(stub.calls.some(call => call.path === '/api/remote/controller/account/start')).toBe(false);
      expect(post.body).toEqual({
        server_url: 'https://remote.example.com',
        code: 'ABCD-EFGH',
        name: 'Mac mini',
      });
      await screen.findByText('Mac mini');
    } finally {
      stub.restore();
    }
  });

  it('says why a pairing failed: refused by the Remote Server, Server unreachable or busy, or anything else', async () => {
    const stub = stubEnvironments([], false, [
      () => Response.json({ error: 'pairing_rejected', code: 'AUTH_REQUIRED' }, { status: 409 }),
      () => Response.json({ error: 'pairing_unreachable' }, { status: 502 }),
      () => Response.json({ error: 'pairing_rate_limited', retry_after_seconds: 27 },
        { status: 429, headers: { 'retry-after': '27' } }),
      () => new Response('Internal Server Error', { status: 500 }),
    ]);
    renderRemote(createRemoteSettingsFixture({ enrolled: true }));
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
      const dialog = screen.getByRole('dialog', { name: 'Connect another Gian' });
      fireEvent.change(within(dialog).getByLabelText('Host pairing code'), { target: { value: 'ABCD-EFGH' } });
      const connect = within(dialog).getByRole('button', { name: 'Connect' });
      for (const message of [
        'The Remote Server refused this pairing. The code may have expired or already been used.',
        'Could not reach the Remote Server. Check the address and your connection, then try again.',
        'The Remote Server is busy. Try again in 27 seconds.',
        'Connection failed — check the Host pairing code and try again.',
      ]) {
        await waitFor(() => expect(connect).toBeEnabled());
        fireEvent.click(connect);
        await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe(message));
      }
      expect(stub.calls.filter(call => call.method === 'POST' && call.path === '/api/remote/environments')).toHaveLength(4);
      expect(screen.getByRole('dialog', { name: 'Connect another Gian' })).toBeTruthy();
    } finally {
      stub.restore();
    }
  });

  it('the connect dialog pairs without opening a GitHub account dialog', async () => {
    const stub = stubEnvironments([]);
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    const startLogin = vi.fn().mockResolvedValue(undefined);
    fixture.startAccountLogin = startLogin;
    renderRemote(fixture);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
      const dialog = screen.getByRole('dialog', { name: 'Connect another Gian' });
      fireEvent.change(within(dialog).getByLabelText('Host pairing code'), { target: { value: 'ABCD-EFGH' } });
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Mac mini' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
      await screen.findByText('Mac mini');
      expect(startLogin).not.toHaveBeenCalled();
      expect(stub.calls.some(call => call.path.includes('account/start'))).toBe(false);
      expect(screen.queryByRole('dialog', { name: 'Confirm GitHub account' })).toBeNull();
    } finally {
      stub.restore();
    }
  });
});

describe('Settings › Remote — SettingsBody integration', () => {
  function settingsConfig(): SystemConfig {
    return {
      host: '127.0.0.1', port: 8991, workspace_root: '~/Coding',
      theme: 'warm', accent: 'ember', density: 'cozy', locale: 'en',
      font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
      chat_font_size: 14, chat_font_family: 'system',
      terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
      keymap: { preset: 'default', bindings: {} },
      layout: { ...DEFAULT_LAYOUT_PREFERENCES },
      tools: structuredClone(DEFAULT_TOOL_PREFERENCES),
      default_claude_model: '', default_claude_effort: '',
      default_codex_model: '', default_codex_effort: '',
      auth_username: '', external_editors: [], open_apps: {},
    };
  }

  it('exposes the Remote section in the Settings nav and anchors it', () => {
    const fixture = createRemoteSettingsFixture();
    const { container } = renderWithOperations(
      <SettingsBody
        config={settingsConfig()}
        activeSection="remote"
        remoteController={fixture}
      />,
    );
    const navigation = container.querySelector('.settings2-internal-nav')!;
    expect(within(navigation as HTMLElement).getByRole('button', { name: 'Remote' })).toBeTruthy();
    expect(document.getElementById('settings-section-remote')).not.toBeNull();
    expect(screen.getByTestId('settings-remote-enrollment')).toBeTruthy();
  });
});
