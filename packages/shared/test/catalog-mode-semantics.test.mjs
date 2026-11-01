/** Agent identity + capability-driven mode semantics regression. */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { catalogModeSemantics, catalogOptionUsesProviderNativeMode, usesAgentScopedModePreferences } from '../dist/index.js';

function catalog(options) {
  return {
    configOptions: options.map(option => ({
      id: option.id ?? 'mode',
      displayName: option.id ?? 'mode',
      binding: option.binding ?? 'session',
      role: option.role,
      modeKind: option.modeKind,
      control: 'select',
      required: false,
      defaultValue: null,
      choices: option.choices,
    })),
  };
}

test('modeKind marker wins: a provider-native option is provider-native even when turn-bound', () => {
  const dsh = catalog([
    { id: 'dsh_mode', role: 'approval_mode', binding: 'turn', modeKind: 'provider-native', choices: [{ value: 'auto' }] },
  ]);
  assert.equal(catalogModeSemantics('ai.deepseek.harness', dsh), 'provider-native');
  const dshSessionBound = catalog([
    { id: 'dsh_mode', role: 'approval_mode', binding: 'session', modeKind: 'provider-native' },
  ]);
  assert.equal(catalogModeSemantics('ai.deepseek.harness', dshSessionBound), 'provider-native');
});

test('modeKind gian-preset wins even for a kind on the legacy native allowlist', () => {
  const kimi = catalog([
    { id: 'mode', role: 'approval_mode', modeKind: 'gian-preset', choices: [{ value: 'ask' }, { value: 'code' }] },
  ]);
  assert.equal(catalogModeSemantics('kimi', kimi), 'gian-preset');
});

test('providers below the gate fall back to the legacy kind allowlist', () => {
  const unmarked = catalog([{ id: 'mode', role: 'approval_mode' }]);
  assert.equal(catalogModeSemantics('kimi', unmarked), 'provider-native');
  assert.equal(catalogModeSemantics('grok', unmarked), 'provider-native');
  assert.equal(catalogModeSemantics('dsh', unmarked), 'provider-native');
  assert.equal(catalogModeSemantics('claude', unmarked), 'gian-preset');
  assert.equal(catalogModeSemantics('codex', unmarked), 'gian-preset');
  assert.equal(catalogModeSemantics('com.zhipu.zcode', unmarked), 'gian-preset');
});

test('an open pluginId below the gate defaults to Gian presets', () => {
  assert.equal(catalogModeSemantics('com.example.custom', catalog([])), 'gian-preset');
  assert.equal(catalogModeSemantics('com.example.custom', null), 'gian-preset');
});

test('mixed markers resolve provider-native (fail-safe towards verbatim values)', () => {
  const mixed = catalog([
    { id: 'a', role: 'approval_mode', modeKind: 'gian-preset' },
    { id: 'b', role: 'execution_mode', modeKind: 'provider-native' },
  ]);
  assert.equal(catalogModeSemantics('claude', mixed), 'provider-native');
});

test('per-option routing recognizes ungated Claude native permission choices', () => {
  const native = catalog([{
    id: 'permission_mode', role: 'approval_mode', binding: 'turn',
    choices: ['default', 'acceptEdits', 'bypassPermissions', 'auto'].map(value => ({ value })),
  }]).configOptions[0];
  assert.equal(catalogOptionUsesProviderNativeMode('claude', native), true);
});

test('legacy Claude mode preferences remain scoped to the owning Agent', () => {
  assert.equal(usesAgentScopedModePreferences('claude'), true);
  assert.equal(usesAgentScopedModePreferences('codex'), false);
  assert.equal(usesAgentScopedModePreferences('com.example.custom'), false);
});

test('per-option routing honors explicit preset markers before Claude fallback', () => {
  const preset = catalog([{
    id: 'permission_mode', role: 'approval_mode', modeKind: 'gian-preset',
    choices: [{ value: 'default' }, { value: 'acceptEdits' }],
  }]).configOptions[0];
  assert.equal(catalogOptionUsesProviderNativeMode('claude', preset), false);
});

test('per-option routing never classifies model or effort as a native mode', () => {
  for (const role of ['model', 'effort']) {
    const option = catalog([{
      id: role, role, choices: [{ value: 'default' }, { value: 'acceptEdits' }],
    }]).configOptions[0];
    assert.equal(catalogOptionUsesProviderNativeMode('kimi', option), false);
    assert.equal(catalogOptionUsesProviderNativeMode('claude', option), false);
  }
});
