import {
  RemoteProtocolError,
  canonicalIdSchema,
  canonicalJson,
  parseClosed,
  positiveSafeIntegerSchema,
  remoteExecutionBindingInputSchema,
  remoteExecutionTargetSchema,
  type RemoteExecutionBindingInput,
  type RemoteExecutionTarget,
} from '@gian/remote-protocol';
import type { Db } from '../storage/db.js';

export interface RemoteExecutionBinding extends RemoteExecutionBindingInput {
  revision: number;
  execution_started_at: number | null;
  created_at: number;
}

interface BindingRow {
  local_session_id: string;
  server_origin: string;
  server_identity_fingerprint: string;
  account_id: string | null;
  target_version: number | null;
  device_id: string | null;
  device_public_key_json: string | null;
  crypto_connection_id: string | null;
  host_id: string;
  remote_session_id: string;
  revision: number;
  execution_started_at: number | null;
  created_at: number;
}

/** Local product ownership only. The transport authenticates the target
 * before using a binding; persisting this record does not grant remote access. */
export class RemoteExecutionBindings {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  bind(value: RemoteExecutionBindingInput): RemoteExecutionBinding {
    const input = parseClosed(remoteExecutionBindingInputSchema, value);
    return this.db.transaction(() => {
      const session = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(input.local_session_id);
      if (!session) throw new RemoteProtocolError('RESOURCE_NOT_FOUND', 'local session not found');
      const current = this.get(input.local_session_id);
      if (current) {
        if (!sameTarget(current.target, input.target)) throw conflict();
        return current;
      }
      this.assertNotExecuted(input.local_session_id);
      this.assertUnclaimed(input.target, input.local_session_id);
      const target = input.target;
      const device = 'target_version' in target ? target : null;
      this.db.prepare(`INSERT INTO remote_execution_bindings
        (local_session_id, server_origin, server_identity_fingerprint, account_id,
          target_version, device_id, device_public_key_json, crypto_connection_id,
          host_id, remote_session_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.local_session_id, target.server_origin, target.server_identity_fingerprint,
          'target_version' in target ? null : target.account_id, device?.target_version ?? null, device?.device_id ?? null,
          device ? JSON.stringify(device.device_public_key) : null, device?.crypto_connection_id ?? null,
          target.host_id, target.remote_session_id, this.now());
      return this.require(input.local_session_id);
    })();
  }

  get(localSessionId: string): RemoteExecutionBinding | null {
    parseClosed(canonicalIdSchema, localSessionId);
    const row = this.db.prepare('SELECT * FROM remote_execution_bindings WHERE local_session_id = ?')
      .get(localSessionId) as BindingRow | undefined;
    return row ? project(row) : null;
  }

  find(target: RemoteExecutionTarget): RemoteExecutionBinding | null {
    const parsed = parseClosed(remoteExecutionTargetSchema, target);
    const row = 'target_version' in parsed
      ? this.db.prepare(`SELECT * FROM remote_execution_bindings WHERE target_version = 2
          AND server_origin = ? AND server_identity_fingerprint = ? AND host_id = ? AND remote_session_id = ?
          AND device_id = ? AND crypto_connection_id = ?`)
        .get(parsed.server_origin, parsed.server_identity_fingerprint, parsed.host_id,
          parsed.remote_session_id, parsed.device_id, parsed.crypto_connection_id) as BindingRow | undefined
      : this.db.prepare(`SELECT * FROM remote_execution_bindings WHERE target_version IS NULL
          AND server_origin = ? AND server_identity_fingerprint = ? AND account_id = ?
          AND host_id = ? AND remote_session_id = ?`)
        .get(parsed.server_origin, parsed.server_identity_fingerprint, parsed.account_id,
          parsed.host_id, parsed.remote_session_id) as BindingRow | undefined;
    return row ? project(row) : null;
  }

  findRemoteSession(target: RemoteExecutionTarget): RemoteExecutionBinding | null {
    const parsed = parseClosed(remoteExecutionTargetSchema, target);
    const rows = this.db.prepare(`SELECT * FROM remote_execution_bindings
      WHERE server_origin = ? AND server_identity_fingerprint = ? AND host_id = ? AND remote_session_id = ?`)
      .all(parsed.server_origin, parsed.server_identity_fingerprint, parsed.host_id, parsed.remote_session_id) as BindingRow[];
    if (rows.length > 1) throw conflict();
    return rows[0] ? project(rows[0]) : null;
  }

  retarget(localSessionId: string, expectedRevision: number, target: RemoteExecutionTarget): RemoteExecutionBinding {
    const next = parseClosed(remoteExecutionTargetSchema, target);
    parseClosed(positiveSafeIntegerSchema, expectedRevision);
    return this.db.transaction(() => {
      const current = this.require(localSessionId);
      if (current.revision !== expectedRevision) throw conflict();
      if (sameTarget(current.target, next)) return current;
      if (current.execution_started_at !== null) {
        throw new RemoteProtocolError('PRECONDITION_FAILED', 'execution environment is already fixed');
      }
      this.assertNotExecuted(localSessionId);
      this.assertUnclaimed(next, localSessionId);
      const device = 'target_version' in next ? next : null;
      this.db.prepare(`UPDATE remote_execution_bindings SET
        server_origin = ?, server_identity_fingerprint = ?, account_id = ?, target_version = ?,
        device_id = ?, device_public_key_json = ?, crypto_connection_id = ?,
        host_id = ?, remote_session_id = ?, revision = revision + 1
        WHERE local_session_id = ?`)
        .run(next.server_origin, next.server_identity_fingerprint, 'target_version' in next ? null : next.account_id,
          device?.target_version ?? null, device?.device_id ?? null,
          device ? JSON.stringify(device.device_public_key) : null, device?.crypto_connection_id ?? null,
          next.host_id, next.remote_session_id, localSessionId);
      return this.require(localSessionId);
    })();
  }

  /** Freeze before dispatch, including uncertain outcomes. A timeout must not
   * make a running remote command eligible for migration to a different Host. */
  markStarted(localSessionId: string, expectedRevision: number): RemoteExecutionBinding {
    parseClosed(positiveSafeIntegerSchema, expectedRevision);
    return this.db.transaction(() => {
      const current = this.require(localSessionId);
      if (current.revision !== expectedRevision) throw conflict();
      if (current.execution_started_at === null) {
        this.db.prepare('UPDATE remote_execution_bindings SET execution_started_at = ? WHERE local_session_id = ?')
          .run(this.now(), localSessionId);
      }
      return this.require(localSessionId);
    })();
  }

  assertCurrent(captured: RemoteExecutionBinding): RemoteExecutionBinding {
    const input = parseClosed(remoteExecutionBindingInputSchema, {
      local_session_id: captured.local_session_id, target: captured.target,
    });
    const current = this.require(input.local_session_id);
    if (current.revision !== captured.revision || !sameTarget(current.target, input.target)) throw conflict();
    return current;
  }

  private require(localSessionId: string): RemoteExecutionBinding {
    const value = this.get(localSessionId);
    if (!value) throw new RemoteProtocolError('RESOURCE_NOT_FOUND', 'execution binding not found');
    return value;
  }

  private assertUnclaimed(target: RemoteExecutionTarget, localSessionId: string): void {
    const existing = this.findRemoteSession(target);
    if (existing && existing.local_session_id !== localSessionId) {
      throw new RemoteProtocolError('PRECONDITION_FAILED', 'execution already has a local session');
    }
  }

  private assertNotExecuted(localSessionId: string): void {
    const row = this.db.prepare(`SELECT status,
      EXISTS(SELECT 1 FROM turns WHERE session_id = sessions.id) AS has_turns
      FROM sessions WHERE id = ?`).get(localSessionId) as { status: string; has_turns: number } | undefined;
    if (!row || row.status !== 'new' || row.has_turns !== 0) {
      throw new RemoteProtocolError('PRECONDITION_FAILED', 'session has already executed');
    }
  }
}

function project(row: BindingRow): RemoteExecutionBinding {
  const target = row.target_version === 2 ? {
    target_version: 2,
    server_origin: row.server_origin,
    server_identity_fingerprint: row.server_identity_fingerprint,
    host_id: row.host_id,
    remote_session_id: row.remote_session_id,
    device_id: row.device_id,
    device_public_key: row.device_public_key_json ? JSON.parse(row.device_public_key_json) : null,
    crypto_connection_id: row.crypto_connection_id,
  } : {
    server_origin: row.server_origin,
    server_identity_fingerprint: row.server_identity_fingerprint,
    account_id: row.account_id,
    host_id: row.host_id,
    remote_session_id: row.remote_session_id,
  };
  return {
    local_session_id: row.local_session_id,
    revision: row.revision,
    execution_started_at: row.execution_started_at,
    created_at: row.created_at,
    target: parseClosed(remoteExecutionTargetSchema, target),
  };
}

function sameTarget(left: RemoteExecutionTarget, right: RemoteExecutionTarget): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function conflict(): RemoteProtocolError {
  return new RemoteProtocolError('PRECONDITION_FAILED', 'execution binding changed');
}
