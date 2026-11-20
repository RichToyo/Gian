import { describe, expect, it } from 'vitest';
import { remoteEntryDecision, remoteEntryServerOrigin } from '../src/auth/remote-entry.js';

describe('remote entry before GitHub sign-in', () => {
  it('opens Remote only from the desktop GitHub gate after the user chooses it', () => {
    expect(remoteEntryDecision({ authStatus: 'checking', githubDesktop: true, remoteChosen: true })).toBe('checking');
    expect(remoteEntryDecision({ authStatus: 'login', githubDesktop: true, remoteChosen: false })).toBe('login');
    expect(remoteEntryDecision({ authStatus: 'login', githubDesktop: true, remoteChosen: true })).toBe('remote');
    expect(remoteEntryDecision({ authStatus: 'authenticated', githubDesktop: true, remoteChosen: true })).toBe('app');
  });

  it('keeps a password-protected Host on the login gate', () => {
    expect(remoteEntryDecision({ authStatus: 'login', githubDesktop: false, remoteChosen: true })).toBe('login');
    expect(remoteEntryDecision({ authStatus: 'login', githubDesktop: false, remoteChosen: false })).toBe('login');
    expect(remoteEntryDecision({ authStatus: 'authenticated', githubDesktop: false, remoteChosen: false })).toBe('app');
  });

  it('accepts only canonical HTTPS or loopback HTTP Remote Server origins', () => {
    expect(remoteEntryServerOrigin('https://remote.example')).toBe('https://remote.example');
    expect(remoteEntryServerOrigin('https://remote.example:8443')).toBe('https://remote.example:8443');
    expect(remoteEntryServerOrigin('http://127.0.0.1:8992')).toBe('http://127.0.0.1:8992');
    for (const value of ['http://remote.example', 'https://remote.example/', 'https://user@remote.example',
      'https://remote.example/path', 'https://remote.example?token=x', 'not a URL']) {
      expect(remoteEntryServerOrigin(value)).toBeNull();
    }
  });
});
