/**
 * Static search registry (Issue #168 / 0.6.7): settings keyed by real
 * section anchors, commands by real keymap command ids; locale titles plus
 * English aliases; availability predicates; deterministic ranking.
 */
import { describe, expect, it } from 'vitest';
import { KEYMAP_COMMANDS } from '@gian/shared';
import { EN } from '../src/i18n/en.js';
import {
  COMMANDS_SEARCH_REGISTRY,
  SETTINGS_SEARCH_REGISTRY,
  matchRegistryEntries,
  settingAnchorId,
  type SearchPaletteContext,
} from '../src/search/registry.js';

const FULL_CONTEXT: SearchPaletteContext = {
  hasActiveSession: true,
  workbenchActive: true,
  canGoBack: true,
  canGoForward: true,
  inspectorAvailable: true,
  browserAvailable: true,
};

const englishTitles = (entry: { titleKey: string }) => [EN[entry.titleKey] ?? entry.titleKey];

describe('search registry', () => {
  it('every registry command is a real keymap command with a real label', () => {
    const known = new Set<string>(KEYMAP_COMMANDS);
    for (const entry of COMMANDS_SEARCH_REGISTRY) {
      expect(known.has(entry.command)).toBe(true);
      expect(typeof EN[entry.titleKey]).toBe('string');
    }
  });

  it('every settings entry resolves to a real section label', () => {
    for (const entry of SETTINGS_SEARCH_REGISTRY) {
      expect(typeof EN[entry.titleKey]).toBe('string');
    }
  });

  it('matches titles case-insensitively and ranks exact > prefix > substring > alias', () => {
    const matches = matchRegistryEntries(SETTINGS_SEARCH_REGISTRY, 'notifications', englishTitles);
    expect(matches[0]?.entry.navKey).toBe('notifications');
    expect(matches[0]?.rank).toBe(0);

    const alias = matchRegistryEntries(SETTINGS_SEARCH_REGISTRY, 'alerts', englishTitles);
    expect(alias.map(match => match.entry.navKey)).toContain('notifications');
    expect(alias[0]?.rank).toBe(3);
  });

  it('does not expose the removed Language setting', () => {
    expect(SETTINGS_SEARCH_REGISTRY.some(entry => entry.id === 'appearance.language')).toBe(false);
    expect(matchRegistryEntries(SETTINGS_SEARCH_REGISTRY, 'language', englishTitles)).toEqual([]);
  });

  it('unavailable commands are excluded by their predicate', () => {
    const rename = COMMANDS_SEARCH_REGISTRY.find(entry => entry.command === 'session.rename')!;
    expect(rename.available(FULL_CONTEXT)).toBe(true);
    expect(rename.available({ ...FULL_CONTEXT, hasActiveSession: false })).toBe(false);
    const panel3 = COMMANDS_SEARCH_REGISTRY.find(entry => entry.command === 'layout.togglePanel3')!;
    expect(panel3.available({ ...FULL_CONTEXT, inspectorAvailable: false })).toBe(false);
    const settings = COMMANDS_SEARCH_REGISTRY.find(entry => entry.command === 'app.settings')!;
    expect(settings.available({ ...FULL_CONTEXT, hasActiveSession: false, workbenchActive: false })).toBe(true);
  });

  it('matches partial English titles', () => {
    const matches = matchRegistryEntries(SETTINGS_SEARCH_REGISTRY, 'notific', englishTitles);
    expect(matches.map(match => match.entry.navKey)).toContain('notifications');
  });

  it('control-level entries anchor to real rendered control ids', () => {
    const fontSize = SETTINGS_SEARCH_REGISTRY.find(entry => entry.id === 'chat.fontSize')!;
    expect(settingAnchorId(fontSize)).toBe('settings-control-chat.fontSize');
    const section = SETTINGS_SEARCH_REGISTRY.find(entry => entry.id === 'appearance')!;
    expect(settingAnchorId(section)).toBe('settings-section-appearance');
  });

  it('an empty or blank query matches nothing', () => {
    expect(matchRegistryEntries(SETTINGS_SEARCH_REGISTRY, '  ', englishTitles)).toEqual([]);
  });
});
