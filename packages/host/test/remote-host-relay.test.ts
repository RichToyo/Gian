import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { generateCanonicalId } from '@gian/remote-protocol';
import { HostRelaySocket, createCiphertextBudget } from '../src/remote/host-relay.js';

interface Sent { at: number; device: string; bytes: number; frameClass: string; index: number }

type Budget = ReturnType<typeof createCiphertextBudget>;
const RelayConstructor = HostRelaySocket as unknown as new (
  socket: WebSocket,
  limiter?: { wait(): Promise<void> },
  budget?: Budget,
) => HostRelaySocket;

/** A Host relay over a fake open socket, without frame-count pacing. */
function relayWith(budget: Budget) {
  const sent: Sent[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      const frame = JSON.parse(data) as { device_id: string; ciphertext: string; frame_class: string; index: number };
      sent.push({
        at: Date.now(), device: frame.device_id, bytes: frame.ciphertext.length,
        frameClass: frame.frame_class, index: frame.index,
      });
    },
    close() {},
  } as unknown as WebSocket;
  const relay = new RelayConstructor(socket, { wait: async () => {} }, budget);
  return { relay, sent };
}

function frame(deviceId: string, frameClass: 'control' | 'content', bytes: number, index: number) {
  return {
    frame_class: frameClass, device_id: deviceId, connection_id: generateCanonicalId(),
    ciphertext: 'x'.repeat(bytes), index,
  };
}

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Most ciphertext bytes the socket sent within any window of `windowMs`. */
function peakBytes(sent: Sent[], windowMs: number): number {
  let peak = 0;
  for (const start of sent) {
    const total = sent.filter((entry) => entry.at >= start.at && entry.at < start.at + windowMs)
      .reduce((sum, entry) => sum + entry.bytes, 0);
    peak = Math.max(peak, total);
  }
  return peak;
}

test('two devices downloading at once share one byte budget under the Server cap', async () => {
  // Scaled like production: the Host budget is below the Server cap over a
  // longer window (13 MiB per 1.25 s against 16 MiB per 1 s).
  const budgetBytes = 40_000;
  const serverWindowMs = 200;
  const serverCapBytes = 49_000;
  const { relay, sent } = relayWith(createCiphertextBudget(budgetBytes, 250));
  const devices = [generateCanonicalId(), generateCanonicalId()];
  const routes = devices.map((deviceId) => relay.attachDevice(deviceId));
  for (let index = 0; index < 12; index += 1) {
    routes.forEach((route, device) => route.send(frame(devices[device]!, 'content', 5_000, index)));
  }
  await waitUntil(() => sent.length === 24);
  relay.close();
  // Each route alone would fit; together they must still share the budget.
  assert.ok(peakBytes(sent, serverWindowMs) <= budgetBytes, `peak ${peakBytes(sent, serverWindowMs)}`);
  assert.ok(peakBytes(sent, serverWindowMs) < serverCapBytes);
  // The routes take turns instead of one download finishing first.
  const firstTurns = sent.slice(0, 8).map((entry) => entry.device);
  assert.equal(firstTurns.filter((device) => device === devices[0]).length, 4);
  // Each route keeps its sealed order.
  for (const deviceId of devices) {
    const order = sent.filter((entry) => entry.device === deviceId).map((entry) => entry.index);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  }
});

test('a control frame goes ahead of another device\'s queued bulk transfer', async () => {
  const { relay, sent } = relayWith(createCiphertextBudget(10_000, 200));
  const downloading = generateCanonicalId();
  const stopping = generateCanonicalId();
  const bulk = relay.attachDevice(downloading);
  const control = relay.attachDevice(stopping);
  for (let index = 0; index < 6; index += 1) bulk.send(frame(downloading, 'content', 5_000, index));
  await waitUntil(() => sent.length === 2);
  // The budget is spent; the next bulk chunk waits for the window to slide.
  const bulkSentBefore = sent.length;
  control.send(frame(stopping, 'control', 200, 0));
  await waitUntil(() => sent.length === 7);
  relay.close();
  const stopAt = sent.findIndex((entry) => entry.device === stopping);
  assert.ok(stopAt <= bulkSentBefore + 1, `control frame was sent at ${stopAt}`);
  assert.deepEqual(sent.filter((entry) => entry.device === downloading).map((entry) => entry.index), [0, 1, 2, 3, 4, 5]);
});

test('a busy device\'s control stream does not starve another device\'s download', async () => {
  const { relay, sent } = relayWith(createCiphertextBudget());
  const busy = generateCanonicalId();
  const downloading = generateCanonicalId();
  const events = relay.attachDevice(busy);
  const bulk = relay.attachDevice(downloading);
  for (let index = 0; index < 6; index += 1) {
    events.send(frame(busy, 'control', 100, index));
    bulk.send(frame(downloading, 'content', 1_000, index));
  }
  await waitUntil(() => sent.length === 12);
  relay.close();
  // One frame per route per round: control first within the round, then content.
  assert.deepEqual(sent.slice(0, 6).map((entry) => entry.frameClass),
    ['control', 'content', 'control', 'content', 'control', 'content']);
});

test('the byte budget frees as the window slides and admits a lone oversized frame', async () => {
  const budget = createCiphertextBudget(1_000, 30);
  assert.equal(budget.fits(5_000), true);
  budget.note(800);
  assert.equal(budget.fits(200), true);
  assert.equal(budget.fits(201), false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(budget.fits(1_000), true);
});
