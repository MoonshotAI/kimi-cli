import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';

import { KaosFileExistsError } from '../src/errors.js';
import { LocalKaos } from '../src/local.js';

function nodeArgs(code: string): string[] {
  return ['node', '-e', code];
}

describe('LocalKaos', () => {
  let kaos: LocalKaos;
  let tempDir: string;

  beforeEach(async () => {
    kaos = new LocalKaos();
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'kaos-test-')));
    await kaos.chdir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('pathClass, gethome, getcwd', () => {
    it('should return posix or win32 pathClass', () => {
      const cls = kaos.pathClass();
      if (process.platform === 'win32') {
        expect(cls).toBe('win32');
      } else {
        expect(cls).toBe('posix');
      }
    });

    it('should return the home directory', () => {
      // Python test_local_kaos.py pins `str(gethome()) == str(Path.home())`;
      // asserting length > 0 alone was too weak — a stub returning any
      // non-empty string would pass.
      const home = kaos.gethome();
      expect(home).toBe(homedir());
    });

    it('should return the current working directory', () => {
      const cwd = kaos.getcwd();
      expect(cwd).toBe(tempDir);
    });
  });

  describe('chdir + stat', () => {
    it('should change directory and stat a file', async () => {
      const nested = join(tempDir, 'nested');
      await kaos.mkdir(nested);

      await kaos.chdir(nested);
      expect(kaos.getcwd()).toBe(nested);

      const filePath = join(nested, 'file.txt');
      await kaos.writeText(filePath, 'hello world');

      const statResult = await kaos.stat(filePath);
      expect(statResult.stSize).toBe(Buffer.byteLength('hello world', 'utf-8'));
    });

    it('should reject chdir into a regular file', async () => {
      // chdir must explicitly refuse targets that resolve to non-directories
      // so relative I/O calls after the chdir do not silently treat a file
      // path as a working directory.
      const filePath = join(tempDir, 'not-a-dir.txt');
      await kaos.writeText(filePath, 'content');
      await expect(kaos.chdir(filePath)).rejects.toThrow(/Not a directory/);
    });
  });

  describe('iterdir path normalization', () => {
    it('should produce normalized paths even when the argument has a trailing separator', async () => {
      // Regression: previously, iterdir manually concatenated `resolved + sep
      // + entry`, which produced `//entry` for roots like `/` and `C:\\entry`
      // for Windows drives. Using pathJoin correctly collapses the extra
      // separator.
      await kaos.writeText(join(tempDir, 'file.txt'), 'x');

      const entries: string[] = [];
      // Pass tempDir with an explicit trailing slash to simulate the root
      // edge case without needing a writable filesystem root in the test.
      for await (const entry of kaos.iterdir(tempDir + '/')) {
        entries.push(entry);
      }

      expect(entries).toContain(join(tempDir, 'file.txt'));
      // No entry should contain duplicated separators.
      expect(entries.every((e) => !e.includes('//'))).toBe(true);
    });
  });

  describe('iterdir + glob', () => {
    it('should list directory entries and match glob patterns', async () => {
      await kaos.mkdir(join(tempDir, 'alpha'));
      await kaos.writeText(join(tempDir, 'bravo.txt'), 'bravo');
      await kaos.writeText(join(tempDir, 'charlie.TXT'), 'charlie');

      const entries: string[] = [];
      for await (const entry of kaos.iterdir(tempDir)) {
        entries.push(entry);
      }
      const names = entries.map((e) => e.split('/').pop()!);
      expect(new Set(names)).toEqual(new Set(['alpha', 'bravo.txt', 'charlie.TXT']));

      const matched: string[] = [];
      for await (const entry of kaos.glob(tempDir, '*.txt')) {
        matched.push(entry);
      }
      const matchedNames = matched.map((e) => e.split('/').pop()!);
      expect(new Set(matchedNames)).toEqual(new Set(['bravo.txt']));
    });
  });

  describe('glob hidden files', () => {
    it('should include hidden files in glob results', async () => {
      await kaos.writeText(join(tempDir, '.gitlab-ci.yml'), 'stages: [build]');
      await kaos.writeText(join(tempDir, 'config.yml'), 'key: value');

      const matched: string[] = [];
      for await (const entry of kaos.glob(tempDir, '*.yml')) {
        matched.push(entry);
      }
      const names = matched.map((e) => e.split('/').pop()!);
      expect(names).toContain('.gitlab-ci.yml');
      expect(names).toContain('config.yml');
    });

    it('should glob through hidden directories with ** pattern', async () => {
      await kaos.mkdir(join(tempDir, 'src'));
      await kaos.mkdir(join(tempDir, 'src', '.config'));
      await kaos.writeText(join(tempDir, 'src', '.config', 'settings.yml'), 'debug: true');
      await kaos.writeText(join(tempDir, 'src', 'main.ts'), 'pass');

      const deepMatched: string[] = [];
      for await (const entry of kaos.glob(tempDir, 'src/**/*.yml')) {
        deepMatched.push(entry);
      }
      expect(deepMatched.some((p) => p.includes('.config'))).toBe(true);
    });
  });

  describe('readText/writeText', () => {
    it('should write, read, append, and readLines', async () => {
      const filePath = join(tempDir, 'note.txt');

      const written = await kaos.writeText(filePath, 'line1');
      expect(written).toBe('line1'.length);

      const content = await kaos.readText(filePath);
      expect(content).toBe('line1');

      await kaos.writeText(filePath, '\nline2', { mode: 'a' });

      const lines: string[] = [];
      for await (const line of kaos.readLines(filePath)) {
        lines.push(line);
      }
      expect(lines.join('')).toBe('line1\nline2');
    });
  });

  describe('readText errors parameter (Python compat)', () => {
    // A file with a valid UTF-8 prefix "中", an invalid standalone byte 0xff,
    // and a valid UTF-8 suffix "文". Under strict decoding this throws.
    const invalidBytes = Buffer.concat([
      Buffer.from([0xe4, 0xb8, 0xad]), // 中
      Buffer.from([0xff]),
      Buffer.from([0xe6, 0x96, 0x87]), // 文
    ]);

    it('throws on invalid utf-8 with errors="strict" (default)', async () => {
      const filePath = join(tempDir, 'invalid.txt');
      await kaos.writeBytes(filePath, invalidBytes);

      await expect(kaos.readText(filePath)).rejects.toThrow();
      await expect(kaos.readText(filePath, { errors: 'strict' })).rejects.toThrow();
    });

    it('returns U+FFFD replacement characters with errors="replace"', async () => {
      const filePath = join(tempDir, 'replace.txt');
      await kaos.writeBytes(filePath, invalidBytes);

      const content = await kaos.readText(filePath, { errors: 'replace' });
      expect(content).toContain('\uFFFD');
      expect(content).toContain('中');
      expect(content).toContain('文');
    });

    it('drops invalid bytes with errors="ignore"', async () => {
      const filePath = join(tempDir, 'ignore.txt');
      await kaos.writeBytes(filePath, invalidBytes);

      const content = await kaos.readText(filePath, { errors: 'ignore' });
      expect(content).toBe('中文');
      expect(content).not.toContain('\uFFFD');
    });
  });

  describe('LF preservation', () => {
    it('should not convert LF to CRLF', async () => {
      const filePath = join(tempDir, 'lf.txt');
      await kaos.writeText(filePath, 'hello\nworld\n');

      const raw = await kaos.readBytes(filePath);
      expect(raw).toEqual(Buffer.from('hello\nworld\n'));
    });
  });

  describe('CRLF preservation', () => {
    it('should preserve CRLF line endings', async () => {
      const filePath = join(tempDir, 'crlf.txt');
      await kaos.writeText(filePath, 'hello\r\nworld\r\n');

      const raw = await kaos.readBytes(filePath);
      expect(raw).toEqual(Buffer.from('hello\r\nworld\r\n'));
    });
  });

  describe('mkdir recursive', () => {
    it('should create nested directories with parents option', async () => {
      const nested = join(tempDir, 'a', 'b', 'c');
      await kaos.mkdir(nested, { parents: true });

      const s = await kaos.stat(nested);
      // Check it's a directory (mode has the directory bit set)
      // S_IFDIR = 0o040000
      expect(s.stMode & 0o170000).toBe(0o040000);
    });

    it('should throw when parents:true + existOk:false on existing dir', async () => {
      // Regression: fs.mkdir({ recursive: true }) silently succeeds on an
      // existing directory. mkdir({ parents: true, existOk: false }) must
      // still reject to match the advertised semantics.
      const existing = join(tempDir, 'existing');
      await kaos.mkdir(existing);

      await expect(kaos.mkdir(existing, { parents: true, existOk: false })).rejects.toThrow();
    });

    it('should succeed when parents:true + existOk:true on existing dir', async () => {
      const existing = join(tempDir, 'existing');
      await kaos.mkdir(existing);

      await expect(kaos.mkdir(existing, { parents: true, existOk: true })).resolves.toBeUndefined();
    });

    it('should throw when existOk:true but conflicting path is a file', async () => {
      // Regression (Codex Round 9 P2): if the target path already exists
      // as a regular file, `existOk` must not silently "succeed" — there
      // is still no directory at that path after the call.
      const filePath = join(tempDir, 'not-a-dir.txt');
      await kaos.writeText(filePath, 'hello');

      await expect(kaos.mkdir(filePath, { existOk: true })).rejects.toBeInstanceOf(
        KaosFileExistsError,
      );
    });
  });

  describe('glob character class negation', () => {
    it('[!a] should match non-a files (glob negation, not literal `!`)', async () => {
      // Regression (Codex Round 9 P2): `globPatternToRegex` was passing
      // glob character classes through to JS regex verbatim, so `[!a]`
      // was being compiled as `[!a]` (literal `!` or `a`) instead of
      // the glob-style "anything except `a`" semantics.
      await kaos.writeText(join(tempDir, 'a.txt'), '');
      await kaos.writeText(join(tempDir, 'b.txt'), '');
      await kaos.writeText(join(tempDir, '!.txt'), '');

      const matches: string[] = [];
      for await (const m of kaos.glob(tempDir, '[!a].txt')) {
        matches.push(m);
      }
      const names = new Set(matches.map((p) => p.split(/[/\\]/).pop()!));

      expect(names.has('a.txt')).toBe(false);
      expect(names.has('b.txt')).toBe(true);
      expect(names.has('!.txt')).toBe(true);
    });
  });

  describe('glob ** pattern', () => {
    it('should not return duplicates when ** matches nested paths', async () => {
      // Regression for the `**` double-recursion bug: a single file nested
      // two levels deep must appear exactly once, not 2^depth times.
      await kaos.mkdir(join(tempDir, 'a', 'b'), { parents: true });
      await kaos.writeText(join(tempDir, 'a', 'b', 'file.txt'), 'content');

      const matches: string[] = [];
      for await (const m of kaos.glob(tempDir, '**/*.txt')) {
        matches.push(m);
      }

      expect(matches).toHaveLength(1);
      expect(new Set(matches).size).toBe(matches.length);
    });

    it('should match ** at multiple depths without duplicates', async () => {
      await kaos.mkdir(join(tempDir, 'a', 'b', 'c'), { parents: true });
      await kaos.writeText(join(tempDir, 'root.txt'), '');
      await kaos.writeText(join(tempDir, 'a', 'mid.txt'), '');
      await kaos.writeText(join(tempDir, 'a', 'b', 'c', 'deep.txt'), '');

      const matches: string[] = [];
      for await (const m of kaos.glob(tempDir, '**/*.txt')) {
        matches.push(m);
      }

      expect(matches).toHaveLength(3);
      expect(new Set(matches).size).toBe(3);
      const names = new Set(matches.map((p) => p.split(/[/\\]/).pop()!));
      expect(names).toEqual(new Set(['root.txt', 'mid.txt', 'deep.txt']));
    });

    it('should not duplicate matches for deep ** patterns', async () => {
      // Before the fix, each added depth level doubled the duplicate count.
      // Build a 4-level-deep tree with a file at the bottom.
      await kaos.mkdir(join(tempDir, 'l1', 'l2', 'l3', 'l4'), { parents: true });
      await kaos.writeText(join(tempDir, 'l1', 'l2', 'l3', 'l4', 'deep.txt'), 'x');

      const matches: string[] = [];
      for await (const m of kaos.glob(tempDir, '**/*.txt')) {
        matches.push(m);
      }

      expect(matches).toHaveLength(1);
    });

    it('should yield basePath and every recursive entry when the whole pattern is **', async () => {
      // A bare `**` pattern enters the final-segment branch of _globWalk and
      // must (a) emit basePath itself for the zero-directory match and
      // (b) walk every file/dir below it as additional matches.
      await kaos.mkdir(join(tempDir, 'sub'));
      await kaos.writeText(join(tempDir, 'root.txt'), 'r');
      await kaos.writeText(join(tempDir, 'sub', 'nested.txt'), 'n');

      const matches: string[] = [];
      for await (const m of kaos.glob(tempDir, '**')) {
        matches.push(m);
      }

      const names = new Set(matches.map((p) => p.split(/[/\\]/).pop() ?? ''));
      expect(matches).toContain(tempDir);
      expect(names.has('root.txt')).toBe(true);
      expect(names.has('nested.txt')).toBe(true);
      expect(names.has('sub')).toBe(true);
    });
  });

  describe('readBytes/writeBytes', () => {
    it('should round-trip binary data', async () => {
      const filePath = join(tempDir, 'data.bin');
      const data = Buffer.from([0x00, 0x01, 0x02, 0xff]);

      const written = await kaos.writeBytes(filePath, data);
      expect(written).toBe(4);

      const read = await kaos.readBytes(filePath);
      expect(Buffer.compare(read, data)).toBe(0);
    });
  });

  describe('exec streaming', () => {
    it('should run a command and stream stdout/stderr', async () => {
      const code = `process.stdout.write('hello\\n'); process.stderr.write('stderr line\\n');`;
      const proc = await kaos.exec(...nodeArgs(code));

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const stdoutDone = new Promise<void>((resolve) => {
        proc.stdout.on('data', (chunk: Buffer) => {
          stdoutChunks.push(chunk);
        });
        proc.stdout.on('end', () => {
          resolve();
        });
      });

      const stderrDone = new Promise<void>((resolve) => {
        proc.stderr.on('data', (chunk: Buffer) => {
          stderrChunks.push(chunk);
        });
        proc.stderr.on('end', () => {
          resolve();
        });
      });

      const exitCode = await proc.wait();
      await stdoutDone;
      await stderrDone;

      expect(exitCode).toBe(0);
      expect(Buffer.concat(stdoutChunks).toString('utf-8').trim()).toBe('hello');
      expect(Buffer.concat(stderrChunks).toString('utf-8').trim()).toBe('stderr line');
    });
  });

  describe('exec wait-before-read', () => {
    it('should buffer output and allow reading after wait', async () => {
      const code = `process.stdout.write('hello\\n'); process.stderr.write('stderr line\\n');`;
      const proc = await kaos.exec(...nodeArgs(code));

      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      // Read streams after process has already exited
      const stdoutData = await streamToBuffer(proc.stdout);
      const stderrData = await streamToBuffer(proc.stderr);

      expect(stdoutData.toString('utf-8').trim()).toBe('hello');
      expect(stderrData.toString('utf-8').trim()).toBe('stderr line');
    });
  });

  describe('exec non-zero exit', () => {
    it('should return the correct exit code', async () => {
      const proc = await kaos.exec(...nodeArgs('process.exit(7)'));
      const exitCode = await proc.wait();
      expect(exitCode).toBe(7);
      expect(proc.exitCode).toBe(7);
    });
  });

  describe('exec spawn failure', () => {
    it('should reject when the binary does not exist', async () => {
      await expect(kaos.exec('/absolutely/non-existent/binary')).rejects.toThrow();
    });

    it('should reject exec() with no arguments', async () => {
      // exec(...args) requires at least one argument (the command name).
      // Cast through the loose signature so the call even compiles.
      await expect((kaos.exec as () => Promise<unknown>)()).rejects.toThrow(
        /at least one argument/,
      );
    });

    it('should reject execWithEnv() with an empty args array', async () => {
      // Mirrors the exec() guard: execWithEnv must also demand at least
      // one argument (the command itself).
      await expect(kaos.execWithEnv([])).rejects.toThrow(/at least one argument/);
    });
  });

  describe('exec timeout', () => {
    it('should allow killing a long-running process', async () => {
      const code = `setTimeout(() => {}, 10000);`;
      const proc = await kaos.exec(...nodeArgs(code));

      expect(proc.pid).toBeGreaterThan(0);

      // Use a short timeout via Promise.race
      const result = await Promise.race([
        proc.wait().then((exitCode) => ({ kind: 'exited' as const, code: exitCode })),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          setTimeout(() => {
            resolve({ kind: 'timeout' });
          }, 50),
        ),
      ]);

      expect(result.kind).toBe('timeout');

      // Kill the process
      await proc.kill('SIGKILL');
      const exitCode = await proc.wait();
      // On Unix, killed processes typically have negative exit or 137
      expect(exitCode).not.toBe(0);
    });
  });
});

describe('LocalKaos instance isolation', () => {
  test('instances have isolated cwds (no process.cwd pollution)', async () => {
    const kaosA = new LocalKaos();
    const kaosB = new LocalKaos();

    const tmpA = await realpath(await mkdtemp(join(tmpdir(), 'kaos-a-')));
    const tmpB = await realpath(await mkdtemp(join(tmpdir(), 'kaos-b-')));

    try {
      await kaosA.chdir(tmpA);
      await kaosB.chdir(tmpB);

      // kaosA.chdir must not affect kaosB's cwd (no process.chdir pollution).
      expect(kaosA.getcwd()).toBe(tmpA);
      expect(kaosB.getcwd()).toBe(tmpB);

      // Write a file named "marker.txt" in each cwd using a relative path.
      await kaosA.writeText('marker.txt', 'A');
      await kaosB.writeText('marker.txt', 'B');

      // Read back via each kaos — each should get its own version.
      expect(await kaosA.readText('marker.txt')).toBe('A');
      expect(await kaosB.readText('marker.txt')).toBe('B');

      // exec() should also honour the instance cwd.
      const procA = await kaosA.exec('node', '-e', 'process.stdout.write(process.cwd())');
      const procB = await kaosB.exec('node', '-e', 'process.stdout.write(process.cwd())');
      await procA.wait();
      await procB.wait();
      const outA = await streamToBuffer(procA.stdout);
      const outB = await streamToBuffer(procB.stdout);
      expect(outA.toString('utf-8')).toBe(tmpA);
      expect(outB.toString('utf-8')).toBe(tmpB);
    } finally {
      await rm(tmpA, { recursive: true, force: true });
      await rm(tmpB, { recursive: true, force: true });
    }
  });
});

describe('LocalProcess.kill safety', () => {
  test('kill() is safe when spawn failed (pid -1 must not signal process group)', async () => {
    const kaos = new LocalKaos();

    // Try to spawn a nonexistent command. Node's spawn() returns a
    // ChildProcess immediately with pid=undefined; the "error" event
    // arrives asynchronously.
    let proc;
    try {
      proc = await kaos.exec('this-command-does-not-exist-xyz123');
    } catch {
      // If the environment threw synchronously, there's nothing to kill.
      return;
    }

    // If pid is -1, kill must be a no-op and must NOT call
    // process.kill(-1, ...) which would signal the entire process group.
    if (proc.pid <= 0) {
      await expect(proc.kill('SIGTERM')).resolves.toBeUndefined();
    }

    // Drain error event so the test runner doesn't leak unhandled errors.
    try {
      await proc.wait();
    } catch {
      // Expected for nonexistent commands.
    }
  });

  test('kill() handles already-exited process gracefully (ESRCH ignored)', async () => {
    const kaos = new LocalKaos();
    const proc = await kaos.exec('node', '-e', 'process.exit(0)');
    await proc.wait();

    // Calling kill after exit should not throw — ESRCH is ignored.
    await expect(proc.kill('SIGTERM')).resolves.toBeUndefined();
  });

  // ── Phase 14 decision #7 — Windows process-group kill (TDD) ─────────
  //
  // v2-update §7.7 requires a cross-platform "kill the whole process
  // tree" contract. On POSIX this already works because LocalKaos
  // spawns children in a new process group and `process.kill(-pid,
  // SIGTERM)` signals the group. On Windows the Node default kills
  // only the shell parent; grandchildren leak and can run beyond the
  // two-phase kill grace window.
  //
  // This test boots a nested process chain (parent → child → grandchild)
  // and asserts that `proc.kill('SIGTERM')` tears the whole tree down.
  // The grandchild is probed via its pidfile: if the file still names a
  // live pid after the kill, the tree leaked.
  test.skipIf(process.platform !== 'win32')(
    'kill() terminates the grandchild on Windows (process tree)',
    async () => {
      const kaos = new LocalKaos();
      const tmp = await realpath(await mkdtemp(join(tmpdir(), 'kaos-killtree-')));
      try {
        const pidFile = join(tmp, 'grandchild.pid').replaceAll('\\', '\\\\');
        // Parent: spawns a child that spawns a grandchild (long-running).
        // The grandchild writes its own pid to a file so the test can
        // later check if it's still alive.
        const code = `
          const { spawn } = require('node:child_process');
          const child = spawn(process.execPath, ['-e', \`
            const { spawn } = require('node:child_process');
            const { writeFileSync } = require('node:fs');
            const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
            writeFileSync('${pidFile}', String(g.pid));
            setInterval(() => {}, 1000);
          \`], { stdio: 'inherit' });
          setInterval(() => {}, 1000);
        `;
        const proc = await kaos.exec('node', '-e', code);

        // Wait for grandchild pid to be written.
        const { stat, readFile } = await import('node:fs/promises');
        const pidPath = join(tmp, 'grandchild.pid');
        const start = Date.now();
        while (Date.now() - start < 5000) {
          try {
            if ((await stat(pidPath)).isFile()) break;
          } catch {
            /* not yet */
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        const grandchildPid = Number.parseInt(
          (await readFile(pidPath, 'utf-8')).trim(),
          10,
        );
        expect(Number.isNaN(grandchildPid)).toBe(false);

        // Kill parent — on Windows this currently leaks the grandchild
        // unless `taskkill /T /F` (or equivalent) is used.
        await proc.kill('SIGTERM');
        await proc.wait();

        // Give the OS up to 2s to reap the grandchild.
        const reaped = await (async (): Promise<boolean> => {
          for (let i = 0; i < 40; i += 1) {
            try {
              process.kill(grandchildPid, 0); // "is it still alive?"
            } catch {
              return true; // ESRCH — grandchild gone
            }
            await new Promise((r) => setTimeout(r, 50));
          }
          return false;
        })();

        expect(reaped).toBe(true);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
    15_000,
  );

  // ── Phase 15 MAJ-R2-2 — POSIX process-group kill (TDD) ──────────────
  //
  // Round-2 review found that POSIX `spawn` lacked `detached: true`, so
  // `ChildProcess.kill('SIGTERM')` reached only the direct shell parent
  // and left grandchildren running. With the Slice 15 fix
  // (`detached: !isWindows` at spawn + `process.kill(-pid, signal)` in
  // `LocalProcess.kill`) the SIGTERM flows across the whole tree.
  //
  // Structure mirrors the Windows grandchild test above: a Node parent
  // spawns a child that spawns a long-running grandchild and writes its
  // pid to a file. After `proc.kill('SIGTERM')`, the grandchild must
  // be gone within a generous (~2 s) reap window.
  test.skipIf(process.platform === 'win32')(
    'kill() terminates the grandchild on POSIX (process tree)',
    async () => {
      const kaos = new LocalKaos();
      const tmp = await realpath(await mkdtemp(join(tmpdir(), 'kaos-killtree-posix-')));
      try {
        const pidFile = join(tmp, 'grandchild.pid');
        // `exec('bash', '-c', …)` spawns bash as the direct child; the
        // embedded node chain spawns a long-running grandchild under it.
        // The grandchild writes its pid so we can poll liveness.
        const script = `
          node -e 'const { spawn } = require("node:child_process");
            const { writeFileSync } = require("node:fs");
            const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
            writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
            setInterval(() => {}, 1000);'
        `;
        const proc = await kaos.exec('bash', '-c', script);

        const { stat, readFile } = await import('node:fs/promises');
        const start = Date.now();
        while (Date.now() - start < 5000) {
          try {
            if ((await stat(pidFile)).isFile()) break;
          } catch {
            /* not yet */
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        const grandchildPid = Number.parseInt(
          (await readFile(pidFile, 'utf-8')).trim(),
          10,
        );
        expect(Number.isNaN(grandchildPid)).toBe(false);

        await proc.kill('SIGTERM');
        await proc.wait();

        const reaped = await (async (): Promise<boolean> => {
          for (let i = 0; i < 40; i += 1) {
            try {
              process.kill(grandchildPid, 0);
            } catch {
              return true;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
          return false;
        })();

        expect(reaped).toBe(true);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}
