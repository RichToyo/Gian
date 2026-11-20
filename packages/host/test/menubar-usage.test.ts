import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { UsageRecorder, trackingState, type UsageSample } from '../src/usage/recorder.js';
import { UsageQueryService } from '../src/usage/query.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(readFileSync(new URL('../migrations/093_menubar_usage.sql', import.meta.url), 'utf8'));
  trackingState(db, 100);
  const recorder = new UsageRecorder(db);
  const query = new UsageQueryService(db);
  const sample = (key: string, tokens: number, time: number, turn = key): UsageSample => ({
    sourceKey: 'source', sampleKey: key, agentId: 'agent', agentLabel: 'Agent', pluginId: 'codex', modelId: null,
    mode: 'cumulative', hostTurn: turn, turnStartedAt: 200, occurredAt: time, observedAt: time,
    timeBasis: 'provider', totals: { totalTokens: tokens, inputTokens: tokens, outputTokens: 0,
      cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
  });
  const total = () => query.summary({ mode: 'rolling', period: 'day' }, 10_000).totalTokens;
  return { db, recorder, sample, total, query };
}

describe('menubar source-level cumulative accounting', () => {
  it('counts the first terminal of a newly Gian-created native source', () => {
    const { recorder, sample, total } = fixture();
    recorder.bindSource('source', true, 150);
    recorder.record(sample('first-terminal', 75, 300));
    assert.equal(total(), 75);
  });
  it('counts three single-terminal turns against one source baseline', () => {
    const { recorder, sample, total } = fixture();
    recorder.bindSource('source', true, 150);
    recorder.record(sample('one', 100, 300, 'turn-1'));
    recorder.record(sample('two', 250, 400, 'turn-2'));
    recorder.record(sample('three', 420, 500, 'turn-3'));
    assert.equal(total(), 420);
    recorder.record(sample('three', 420, 500, 'turn-3'));
    assert.equal(total(), 420);
  });
  it('anchors old/fork/uncertain sources once, not on every turn', () => {
    for (const bound of [true, false]) {
      const { recorder, sample, total } = fixture();
      if (bound) recorder.bindSource('source', false, 150);
      recorder.record(sample('old-history', 5_000, 300));
      assert.equal(total(), 0);
      recorder.record(sample('local-1', 5_080, 400));
      recorder.record(sample('local-2', 5_200, 500));
      assert.equal(total(), 200);
    }
  });
  it('accepts distinct monotone snapshots at the same millisecond, rejects decreases and older time', () => {
    const { recorder, sample, total } = fixture();
    recorder.bindSource('source', true, 150);
    recorder.record(sample('a', 100, 300));
    recorder.record(sample('b', 160, 300));
    recorder.record(sample('b', 160, 300));
    recorder.record(sample('duplicate-snapshot', 160, 300));
    recorder.record(sample('old', 140, 300));
    recorder.record(sample('reordered', 200, 299));
    recorder.record(sample('c', 210, 301));
    assert.equal(total(), 210);
  });
  it('keeps cursor/identity across reattachment and accounts only after its uncertain gap anchor', () => {
    const { recorder, sample, total } = fixture();
    recorder.bindSource('source', true, 150);
    recorder.record(sample('a', 100, 300));
    recorder.bindSource('source', false, 350);
    recorder.record(sample('old-replay-after-attach', 100, 300));
    recorder.record(sample('external-gap', 800, 400));
    recorder.record(sample('local', 900, 500));
    assert.equal(total(), 200);
  });
  it('an explicit reset starts a zero epoch without replaying old receipts into it', () => {
    const { recorder, sample, total } = fixture();
    recorder.bindSource('source', true, 150);
    recorder.record(sample('old-epoch', 100, 300));
    recorder.record({ ...sample('reset', 0, 350), mode: 'reset' });
    recorder.record(sample('old-epoch', 100, 300));
    recorder.record(sample('unseen-old-event', 90, 299));
    recorder.record(sample('new-epoch', 30, 400));
    assert.equal(total(), 130);
  });
  it('clear keeps tombstones, suppresses active cross-boundary turns and survives Recorder reconstruction', () => {
    const { db, recorder, sample, total } = fixture();
    recorder.bindSource('source', true, 150);
    recorder.record(sample('a', 100, 300));
    assert.deepEqual(recorder.clear(1, 'clear-1', 350), { generation: 2 });
    assert.deepEqual(recorder.clear(1, 'clear-1', 360), { generation: 2 });
    assert.throws(() => recorder.clear(1, 'another', 360), /CONFLICT/);
    recorder.record(sample('a', 100, 300));
    recorder.record(sample('cross-clear-end', 180, 400));
    new UsageRecorder(db).record({ ...sample('new-turn', 220, 500), turnStartedAt: 450 });
    assert.equal(total(), 40);
  });
  it('deduplicates delta steps without losing the second step of a turn', () => {
    const { recorder, sample, total } = fixture();
    for (const key of ['step-1', 'step-1', 'step-2']) recorder.record({ ...sample(key, 30, 300, 'same-turn'), mode: 'delta' });
    assert.equal(total(), 60);
  });
  it('rejects unsafe counters and keeps summary / groups / incremental buckets consistent', () => {
    const { recorder, sample, query } = fixture();
    recorder.bindSource('source', true, 150);
    assert.throws(() => recorder.record(sample('bad', Number.MAX_SAFE_INTEGER + 1, 300)), /counter/);
    recorder.record(sample('a', 50, 300));
    const summary = query.summary({ mode: 'rolling', period: 'day' }, 10_000);
    assert.equal(summary.buckets.reduce((sum, bucket) => sum + (bucket.tokens ?? 0), 0), summary.totalTokens);
    assert.equal(summary.byModel[0]?.id, null);
    assert.equal(summary.byModel[0]?.pluginId, null);
    assert.equal(summary.byAgent[0]?.totalTokens, summary.totalTokens);
    assert.equal(summary.cacheReadTokens, null);
  });
  it('does not cascade numerical history on conversation/Agent deletion', () => {
    const { db, recorder, sample, total } = fixture();
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES (\'conversation\')');
    recorder.bindSource('source', true, 150);
    recorder.record(sample('history', 85, 300));
    db.prepare('DELETE FROM sessions WHERE id = ?').run('conversation');
    assert.equal(total(), 85);
    const removed = new UsageQueryService(db, () => false).summary({ mode: 'rolling', period: 'day' }, 10_000);
    assert.equal(removed.byAgent[0]?.label, 'Removed Agent');
    assert.equal(removed.totalTokens, 85);
  });
  it('uses a generic model icon for multiple Agents even on the same Proxy', () => {
    const { recorder, sample, query } = fixture();
    recorder.record({ ...sample('one', 30, 300), mode: 'delta', modelId: 'actual-model' });
    recorder.record({ ...sample('two', 40, 400), mode: 'delta', sourceKey: 'other-source', agentId: 'other-agent', modelId: 'actual-model' });
    const summary = query.summary({ mode: 'rolling', period: 'day' }, 10_000);
    assert.equal(summary.byModel.length, 1);
    assert.equal(summary.byModel[0]?.totalTokens, 70);
    assert.equal(summary.byModel[0]?.pluginId, null);
  });
});
