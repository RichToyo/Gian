import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { generateCanonicalId, RemoteProtocolError } from '@gian/remote-protocol';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { RemoteControllerHub } from '../src/remote/controller-hub.js';
import { registerSessionRoutes } from '../src/web/routes/sessions.js';
import { WorkbenchTerminalManager } from '../src/term/manager.js';
import { setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

const refused = (feature: string) => (error: RemoteProtocolError) => {
  assert.equal(error.code, 'REMOTE_CAPABILITY_DENIED');
  assert.equal(error.message, `${feature} is not available for sessions running on another Gian.`);
  return true;
};

test('a mirrored session refuses fork, Side Chat and worktree merge or drop plainly, in the session manager and over HTTP', async () => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity, undefined, f.dir);
  try {
    f.sessions.setRemoteController(hub);
    const localId = generateCanonicalId();
    f.db.prepare('INSERT INTO sessions (id, executor, native_session_id) VALUES (?, ?, ?)')
      .run(localId, 'claude', generateCanonicalId());
    hub.bindings.bind({ local_session_id: localId, target: {
      server_origin: 'https://remote.test', server_identity_fingerprint: 'a'.repeat(64),
      account_id: '42', host_id: generateCanonicalId(), remote_session_id: generateCanonicalId(),
    } });

    await assert.rejects(f.sessions.forkSession({ sourceSessionId: localId, sessionId: generateCanonicalId(), anchor: { type: 'head' } }),
      refused('Fork'));
    await assert.rejects(f.sessions.createSidechat(localId), refused('Side Chat'));
    await assert.rejects(f.sessions.resumeSidechat(`sc_${generateCanonicalId()}`, localId), refused('Side Chat'));
    await assert.rejects(f.sessions.mergeWorktree(localId), refused('Merging a worktree'));
    await assert.rejects(f.sessions.dropWorktree(localId), refused('Discarding a worktree'));

    const app = new Hono();
    registerSessionRoutes(app, f.db, f.sessions);
    for (const [action, feature] of [['merge', 'Merging a worktree'], ['drop', 'Discarding a worktree']] as const) {
      const response = await app.request(`/api/sessions/${localId}/${action}`, { method: 'POST' });
      assert.equal(response.status, 403, action);
      assert.deepEqual(await response.json(), { error: `${feature} is not available for sessions running on another Gian.` });
    }

    // A session running here still reaches its own checks.
    const local = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
    const dropped = await app.request(`/api/sessions/${local.id}/drop`, { method: 'POST' });
    assert.equal(dropped.status, 400);
    assert.doesNotMatch(JSON.stringify(await dropped.json()), /another Gian/);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('a terminal never opens in a mirrored session\'s remote worktree', async () => {
  let spawned = 0;
  const manager = new WorkbenchTerminalManager({ broadcast() {} } as unknown as WsBroadcaster, async () => {
    spawned += 1;
    throw new Error('no PTY may be spawned');
  });
  await assert.rejects(manager.spawn({ termId: 'term-1', cols: 80, rows: 24, cwd: `gian-remote://${generateCanonicalId()}` }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'REMOTE_CAPABILITY_DENIED');
      assert.equal(error.message, 'A terminal is not available for sessions running on another Gian.');
      return true;
    });
  assert.equal(spawned, 0);
});
