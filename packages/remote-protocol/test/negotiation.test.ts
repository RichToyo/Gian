import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  acceptRemoteHello, assertFrameClassMatchesInner, createRemoteHello, generateCanonicalId, parseRemoteControlMessage,
  validateRemoteHelloReply,
} from '../src/index.js';

test('business hello is bound to the authenticated device, connection and generation', () => {
  const identity = { deviceId: generateCanonicalId(), connectionId: generateCanonicalId(), hostGeneration: generateCanonicalId(), hostVersion: 'test-host' };
  const offer = createRemoteHello(identity.deviceId, 'test-web');
  const reply = acceptRemoteHello(offer, identity, 123);
  assert.equal(reply.negotiated_minor_version, 3);
  assert.ok(reply.negotiated_capabilities.includes('wire.transcript_page'));
  assert.ok(reply.negotiated_capabilities.includes('wire.host_locale'));
  assert.ok(reply.negotiated_capabilities.includes('wire.conversation_translation'));
  assert.deepEqual(validateRemoteHelloReply(reply, offer, identity.connectionId, identity.hostGeneration), reply);
  assert.throws(() => acceptRemoteHello({ ...offer, device_id: generateCanonicalId() }, identity), /authenticated route/);
  assert.throws(() => validateRemoteHelloReply(reply, offer, generateCanonicalId(), identity.hostGeneration), /authenticated connection/);
  assert.throws(() => validateRemoteHelloReply(reply, offer, identity.connectionId, generateCanonicalId()), /authenticated connection/);
});

test('unsupported versions reject and feature negotiation never invents a capability', () => {
  const identity = { deviceId: generateCanonicalId(), connectionId: generateCanonicalId(), hostGeneration: generateCanonicalId(), hostVersion: 'test-host' };
  const offer = { ...createRemoteHello(identity.deviceId, 'test-web'), capabilities: ['wire.snapshot_parts', 'wire.future'] };
  const reply = acceptRemoteHello(offer, identity);
  assert.deepEqual(reply.negotiated_capabilities, ['wire.snapshot_parts']);
  assert.throws(() => acceptRemoteHello({ ...offer, min_minor_version: 9, max_minor_version: 9 }, identity), /do not overlap/);
  assert.throws(() => validateRemoteHelloReply({ ...reply, negotiated_minor_version: 9 }, offer, identity.connectionId, identity.hostGeneration), /offered protocol/);
  assert.throws(() => validateRemoteHelloReply({ ...reply, negotiated_capabilities: ['wire.content_resume'] }, offer, identity.connectionId, identity.hostGeneration), /offered protocol/);
});

test('a minor-1 client without wire.host_locale negotiates minor 1 and no locale feature', () => {
  const identity = { deviceId: generateCanonicalId(), connectionId: generateCanonicalId(), hostGeneration: generateCanonicalId(), hostVersion: 'test-host' };
  const offer = {
    ...createRemoteHello(identity.deviceId, 'test-web'),
    min_minor_version: 1,
    max_minor_version: 1,
    capabilities: ['wire.snapshot_parts', 'wire.content_resume', 'wire.transcript_page', 'wire.execution_v1'],
  };
  const reply = acceptRemoteHello(offer, identity);
  assert.equal(reply.negotiated_minor_version, 1);
  assert.ok(!reply.negotiated_capabilities.includes('wire.host_locale'));
});

test('a minor-2 client without wire.conversation_translation keeps its features and never sees translation', () => {
  const identity = { deviceId: generateCanonicalId(), connectionId: generateCanonicalId(), hostGeneration: generateCanonicalId(), hostVersion: 'test-host' };
  const offer = {
    ...createRemoteHello(identity.deviceId, 'test-web'),
    min_minor_version: 1,
    max_minor_version: 2,
    capabilities: ['wire.snapshot_parts', 'wire.content_resume', 'wire.transcript_page', 'wire.execution_v1', 'wire.host_locale'],
  };
  const reply = acceptRemoteHello(offer, identity);
  assert.equal(reply.negotiated_minor_version, 2);
  assert.ok(reply.negotiated_capabilities.includes('wire.host_locale'));
  assert.ok(!reply.negotiated_capabilities.includes('wire.conversation_translation'));
});

test('execution hints need an explicit controller opt-in on both peers', () => {
  const identity = { deviceId: generateCanonicalId(), connectionId: generateCanonicalId(), hostGeneration: generateCanonicalId(), hostVersion: 'test-host' };
  const remoteWeb = createRemoteHello(identity.deviceId, 'remote-web');
  assert.equal(remoteWeb.capabilities.includes('wire.execution_hints_v1'), false, 'the default hello never asks for hints');
  assert.equal(createRemoteHello(identity.deviceId, 'native', { sessionDirectoryV1: true }).capabilities
    .includes('wire.execution_hints_v1'), false);
  assert.equal(acceptRemoteHello(remoteWeb, identity).negotiated_capabilities.includes('wire.execution_hints_v1'), false);
  const controller = createRemoteHello(identity.deviceId, 'gian-native', { executionHintsV1: true });
  assert.equal(controller.capabilities.includes('wire.session_directory_v1'), false, 'opting in to one feature opts in to no other');
  const reply = acceptRemoteHello(controller, identity);
  assert.ok(reply.negotiated_capabilities.includes('wire.execution_hints_v1'));
  assert.deepEqual(validateRemoteHelloReply(reply, controller, identity.connectionId, identity.hostGeneration), reply);
  // A Host that predates the feature answers without it; the offer stays valid.
  const older = { ...reply, negotiated_capabilities: reply.negotiated_capabilities.filter(feature => feature !== 'wire.execution_hints_v1') };
  assert.deepEqual(validateRemoteHelloReply(older, controller, identity.connectionId, identity.hostGeneration), older);
  // A Host never grants hints a client did not offer.
  assert.throws(() => validateRemoteHelloReply(reply, remoteWeb, identity.connectionId, identity.hostGeneration), /offered protocol/);
});

test('an execution hint is a closed, content-free, live-only control frame', () => {
  const hint = { type: 'execution.changed', version: 1, host_generation: generateCanonicalId(), session_id: generateCanonicalId(), sequence: 7 };
  assert.deepEqual(parseRemoteControlMessage(hint), hint);
  assert.doesNotThrow(() => assertFrameClassMatchesInner('control', 'execution.changed'));
  assert.throws(() => assertFrameClassMatchesInner('content', 'execution.changed'));
  for (const extra of [{ event_sequence: 4 }, { text: 'conversation text' }, { interaction_id: generateCanonicalId() }]) {
    assert.throws(() => parseRemoteControlMessage({ ...hint, ...extra }));
  }
  assert.throws(() => parseRemoteControlMessage({ ...hint, version: 2 }));
  assert.throws(() => parseRemoteControlMessage({ ...hint, session_id: 'not-a-session' }));
  assert.throws(() => parseRemoteControlMessage({ ...hint, sequence: -1 }));
});

test('execution detail needs its own explicit controller opt-in, never the default Remote Web hello', () => {
  const identity = { deviceId: generateCanonicalId(), connectionId: generateCanonicalId(), hostGeneration: generateCanonicalId(), hostVersion: 'test-host' };
  const remoteWeb = createRemoteHello(identity.deviceId, 'remote-web');
  assert.equal(remoteWeb.capabilities.includes('wire.execution_detail_v1'), false, 'the default hello never asks for detail');
  assert.equal(acceptRemoteHello(remoteWeb, identity).negotiated_capabilities.includes('wire.execution_detail_v1'), false);
  assert.equal(createRemoteHello(identity.deviceId, 'gian-native', { executionHintsV1: true }).capabilities
    .includes('wire.execution_detail_v1'), false, 'hints alone do not opt in to detail');
  const controller = createRemoteHello(identity.deviceId, 'gian-native', { executionHintsV1: true, executionDetailV1: true });
  const reply = acceptRemoteHello(controller, identity);
  assert.ok(reply.negotiated_capabilities.includes('wire.execution_detail_v1'));
  assert.ok(reply.negotiated_capabilities.includes('wire.execution_hints_v1'));
  // A Host that predates the feature answers without it; the offer stays valid.
  const older = { ...reply, negotiated_capabilities: reply.negotiated_capabilities.filter(feature => feature !== 'wire.execution_detail_v1') };
  assert.deepEqual(validateRemoteHelloReply(older, controller, identity.connectionId, identity.hostGeneration), older);
  assert.throws(() => validateRemoteHelloReply(reply, remoteWeb, identity.connectionId, identity.hostGeneration), /offered protocol/);
});
