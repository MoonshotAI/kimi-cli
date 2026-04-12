import { EventEmitter } from 'node:events';
import Module from 'node:module';

import type { AnyAuthMethod, ConnectConfig, SFTPWrapper, Stats as SFTPStats } from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface CreateHarnessState {
  attemptedKeys: string[];
  connectConfigs: ConnectConfig[];
  endCalls: number;
  readFileCalls: string[];
}

interface CreateHarnessOptions {
  onConnect?: (client: EventEmitter, config: ConnectConfig, state: CreateHarnessState) => void;
  readFileValues?: Record<string, string>;
  sftp?: SFTPWrapper;
  sftpError?: Error;
}

interface ModuleLoader {
  _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
}

let restoreModuleLoad: (() => void) | undefined;

function makeStats(isDirectory: boolean): SFTPStats {
  return {
    mode: isDirectory ? 0o040755 : 0o100644,
    uid: 1000,
    gid: 1000,
    size: 0,
    atime: 0,
    mtime: 0,
    isDirectory: () => isDirectory,
    isFile: () => !isDirectory,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function createSuccessfulSftp(): SFTPWrapper {
  return {
    realpath(path: string, callback: (err: Error | undefined, absPath: string) => void): void {
      if (path === '.') {
        callback(undefined, '/home/tester');
        return;
      }
      callback(undefined, path);
    },
    stat(path: string, callback: (err: Error | undefined, stats: SFTPStats) => void): void {
      callback(undefined, makeStats(path !== '/home/tester/file.txt'));
    },
    end(): void {
      // no-op
    },
  } as SFTPWrapper;
}

async function loadSSHModule(options: CreateHarnessOptions = {}): Promise<{
  SSHKaos: typeof import('../src/ssh.js').SSHKaos;
  state: CreateHarnessState;
}> {
  vi.resetModules();

  const state: CreateHarnessState = {
    attemptedKeys: [],
    connectConfigs: [],
    endCalls: 0,
    readFileCalls: [],
  };

  class MockClient extends EventEmitter {
    connect(config: ConnectConfig): void {
      state.connectConfigs.push(config);
      if (options.onConnect) {
        options.onConnect(this, config, state);
        return;
      }
      queueMicrotask(() => {
        this.emit('ready');
      });
    }

    end(): void {
      state.endCalls += 1;
      queueMicrotask(() => {
        this.emit('close');
      });
    }

    sftp(callback: (err?: Error, sftp?: SFTPWrapper) => void): void {
      if (options.sftpError) {
        callback(options.sftpError);
        return;
      }
      callback(undefined, options.sftp ?? createSuccessfulSftp());
    }
  }

  const moduleLoader = Module as unknown as ModuleLoader;
  const originalLoad = moduleLoader._load.bind(moduleLoader);
  moduleLoader._load = (request, parent, isMain) => {
    if (request === 'ssh2') {
      return {
        Client: MockClient,
        utils: {
          sftp: {
            STATUS_CODE: {
              NO_SUCH_FILE: 2,
              PERMISSION_DENIED: 3,
              FAILURE: 4,
              NO_CONNECTION: 6,
              CONNECTION_LOST: 7,
              OP_UNSUPPORTED: 8,
            },
          },
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };
  restoreModuleLoad = () => {
    moduleLoader._load = originalLoad;
  };

  vi.doMock('node:fs/promises', () => ({
    readFile: vi.fn(async (path: string) => {
      state.readFileCalls.push(path);
      const value = options.readFileValues?.[path];
      if (value === undefined) {
        throw new Error(`Unexpected readFile(${path})`);
      }
      return value;
    }),
  }));

  const { SSHKaos } = await import('../src/ssh.js');
  return { SSHKaos, state };
}

afterEach(() => {
  restoreModuleLoad?.();
  restoreModuleLoad = undefined;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('SSHKaos.create()', () => {
  it('rejects a cwd that resolves to a regular file', async () => {
    const sftp = {
      realpath(path: string, callback: (err: Error | undefined, absPath: string) => void): void {
        if (path === '.') {
          callback(undefined, '/home/tester');
          return;
        }
        callback(undefined, '/home/tester/file.txt');
      },
      stat(_path: string, callback: (err: Error | undefined, stats: SFTPStats) => void): void {
        callback(undefined, makeStats(false));
      },
      end(): void {
        // no-op
      },
    } as SFTPWrapper;

    const { SSHKaos, state } = await loadSSHModule({ sftp });

    const error = await SSHKaos.create({
      host: 'example.com',
      username: 'tester',
      cwd: 'file.txt',
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('KaosValueError');
    expect((error as Error).message).toMatch(/not a directory/);
    expect(state.endCalls).toBe(1);
  });

  it('tries multiple private keys via authHandler until one succeeds', async () => {
    const { SSHKaos, state } = await loadSSHModule({
      readFileValues: {
        '/keys/second': 'second-key',
      },
      onConnect(client, config, harnessState) {
        const authHandler = config.authHandler;
        if (typeof authHandler !== 'function') {
          client.emit('error', new Error('missing authHandler'));
          return;
        }

        const requestNextKey = (): void => {
          authHandler([], false, (auth: string | AnyAuthMethod | false) => {
            expect(auth).not.toBe(false);
            expect(typeof auth).toBe('object');
            if (auth === false || typeof auth !== 'object') {
              client.emit('error', new Error('authHandler returned no auth method'));
              return;
            }
            if (auth.type !== 'publickey') {
              client.emit('error', new Error(`unexpected auth type: ${auth.type}`));
              return;
            }
            const key =
              typeof auth.key === 'string'
                ? auth.key
                : Buffer.isBuffer(auth.key)
                  ? auth.key.toString('utf-8')
                  : JSON.stringify(auth.key);
            harnessState.attemptedKeys.push(key);
            if (key === 'first-key') {
              requestNextKey();
              return;
            }
            queueMicrotask(() => {
              client.emit('ready');
            });
          });
        };

        requestNextKey();
      },
    });

    const ssh = await SSHKaos.create({
      host: 'example.com',
      username: 'tester',
      keyContents: ['first-key'],
      keyPaths: ['/keys/second'],
    });

    expect(ssh.getcwd()).toBe('/home/tester');
    expect(state.readFileCalls).toEqual(['/keys/second']);
    expect(state.attemptedKeys).toEqual(['first-key', 'second-key']);
    expect(state.connectConfigs[0]?.authHandler).toBeTypeOf('function');
    expect(state.connectConfigs[0]?.privateKey).toBeUndefined();
  });

  it('ends the client when opening SFTP fails after connect succeeds', async () => {
    const { SSHKaos, state } = await loadSSHModule({
      sftpError: new Error('sftp open failed'),
    });

    await expect(
      SSHKaos.create({
        host: 'example.com',
        username: 'tester',
      }),
    ).rejects.toThrow(/sftp open failed/);
    expect(state.endCalls).toBe(1);
  });

  it('merges extraOptions into the ssh2 ConnectConfig', async () => {
    const { SSHKaos, state } = await loadSSHModule();

    await SSHKaos.create({
      host: 'example.com',
      username: 'tester',
      extraOptions: {
        keepaliveInterval: 10_000,
        readyTimeout: 5_000,
        // Cast to the ssh2 Algorithms shape — deliberately narrow for the test
        // harness so we can assert pass-through without pulling the full ssh2
        // type graph.
        algorithms: { cipher: ['aes256-ctr'] } as never,
      },
    });

    const cfg = state.connectConfigs[0];
    expect(cfg).toBeDefined();
    expect(cfg?.keepaliveInterval).toBe(10_000);
    expect(cfg?.readyTimeout).toBe(5_000);
    expect(cfg?.algorithms).toEqual({ cipher: ['aes256-ctr'] });
    // Managed fields must still come from top-level options.
    expect(cfg?.host).toBe('example.com');
    expect(cfg?.username).toBe('tester');
  });

  it('managed fields override extraOptions when both are specified', async () => {
    const { SSHKaos, state } = await loadSSHModule();

    await SSHKaos.create({
      host: 'managed.example.com',
      username: 'managed',
      extraOptions: {
        // Malicious / accidental attempts to override managed fields must
        // NOT win — the top-level values take precedence.
        host: 'attacker.example.com',
        username: 'attacker',
        port: 1234,
      } as never,
    });

    const cfg = state.connectConfigs[0];
    expect(cfg?.host).toBe('managed.example.com');
    expect(cfg?.username).toBe('managed');
    expect(cfg?.port).toBe(22); // default, not the 1234 from extraOptions
  });
});
