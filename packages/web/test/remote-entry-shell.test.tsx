import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createRemoteSettingsFixture } from '../src/remote-settings/fixture.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { RemoteEntryShell } from '../src/views/RemoteEntryShell.js';

describe('RemoteEntryShell', () => {
  it('keeps local Host enrollment, device management, and native other-Gian controls available before login', async () => {
    const user = userEvent.setup();
    const localController = createRemoteSettingsFixture();
    render(
      <LocaleProvider locale="en">
        <RemoteEntryShell localController={localController} onBack={() => {}} />
      </LocaleProvider>,
    );

    expect(await screen.findByTestId('settings-remote-enrollment')).toBeInTheDocument();
    expect(screen.getByText('Control other Gian')).toBeInTheDocument();
    const otherConnect = screen.getByRole('button', { name: 'Connect' });
    expect(otherConnect).toBeDisabled();
    expect(screen.getByText(/Connect this Gian to a Remote Server first/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Remote Server' });
    await user.type(within(dialog).getByLabelText('Remote Server URL'), 'https://remote.example.com');
    await user.type(within(dialog).getByLabelText('Enrollment token'), 'one-time-code');
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Paired devices')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(otherConnect).toBeEnabled();
  });

  it('offers only the native Host-code flow after enrollment, with no embedded Remote Web or arbitrary Server entry', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const localController = createRemoteSettingsFixture({ enrolled: true });
    render(
      <LocaleProvider locale="en">
        <RemoteEntryShell localController={localController} onBack={onBack} />
      </LocaleProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect another Gian' });
    expect(within(dialog).getByLabelText('Host pairing code')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument();
    expect(within(dialog).getByText('https://remote.example.com')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(2);
    expect(within(dialog).queryByLabelText('Remote Server URL')).toBeNull();
    expect(within(dialog).queryByLabelText('Remote Server')).toBeNull();
    expect(within(dialog).queryByTestId('pairing-qr')).toBeNull();
    expect(within(dialog).queryByLabelText('Pairing link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Remote' })).toBeNull();
    expect(document.querySelector('.rw-app')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
