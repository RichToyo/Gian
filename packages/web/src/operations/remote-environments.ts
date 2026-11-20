import { connectRemoteEnvironment, removeRemoteEnvironment, restoreRemoteEnvironment } from '../api.js';
import type { OperationDispatcher } from './dispatcher.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

interface RemoteEnvironmentOperation {
  id?: string;
  /** With `id`: bring a removed environment back instead of removing it. */
  restore?: boolean;
  connection?: { server_url: string; code: string; name: string; confirm_server_identity?: string };
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

for (const name of ['remote.connectEnvironment', 'remote.removeEnvironment', 'remote.restoreEnvironment'] as const) {
  const operation: OperationDefinition<RemoteEnvironmentOperation, unknown> = {
    policy: 'pending', entityKey: input => `remote-environment:${input.id ?? input.connection?.server_url ?? ''}`,
    execute: async input => {
      try {
        const result = name === 'remote.connectEnvironment' ? await connectRemoteEnvironment(input.connection!)
          : name === 'remote.restoreEnvironment' ? await restoreRemoteEnvironment(input.id!)
            : await removeRemoteEnvironment(input.id!);
        input.resolve(result);
        return result;
      } catch (error) { input.reject(error); throw error; }
    },
    timeoutMs: 30_000,
  };
  registry.register(name, operation);
}

export function dispatchRemoteEnvironment(
  dispatch: OperationDispatcher['dispatch'] | null,
  input: Pick<RemoteEnvironmentOperation, 'id' | 'restore' | 'connection'>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!dispatch) { reject(new Error('Remote environment controls are unavailable.')); return; }
    const name = input.connection ? 'remote.connectEnvironment'
      : input.restore ? 'remote.restoreEnvironment' : 'remote.removeEnvironment';
    try { dispatch(name, { ...input, resolve, reject }); }
    catch (error) { reject(error); }
  });
}
