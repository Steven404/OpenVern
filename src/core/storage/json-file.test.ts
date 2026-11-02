import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonFile } from './json-file';
import { dataPaths, ensureDataDir, expandHome, resolveDataDir } from './paths';
import { cleanupTempDirs, makeTempDir, recordingLogger } from './test-helpers';

cleanupTempDirs();

const counterSchema = z.object({ n: z.number() });
type Counter = z.infer<typeof counterSchema>;

describe('JsonFile', () => {
  it('returns null for a missing file', async () => {
    const dir = await makeTempDir();
    expect(await new JsonFile(path.join(dir, 'x.json'), counterSchema).read()).toBeNull();
  });

  it('serialises concurrent read-modify-write updates (no lost updates)', async () => {
    const dir = await makeTempDir();
    const file = new JsonFile<Counter>(path.join(dir, 'c.json'), counterSchema);
    // Two instances on the same path share one lock.
    const other = new JsonFile<Counter>(path.join(dir, 'c.json'), counterSchema);
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => (i % 2 ? file : other).update((cur) => ({ n: (cur?.n ?? 0) + 1 }))),
    );
    expect(await file.read()).toEqual({ n: 60 });
  });

  it('keeps the file valid while many writes race, and leaves no tmp files behind', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'w.json');
    const file = new JsonFile<Counter>(target, counterSchema);
    const writes = Array.from({ length: 40 }, (_, n) => file.write({ n }));
    const reads = Array.from({ length: 40 }, () => fs.readFile(target, 'utf8').catch(() => '{"n":-1}'));
    await Promise.all(writes);
    for (const raw of await Promise.all(reads)) expect(() => JSON.parse(raw)).not.toThrow();
    expect(await file.read()).toEqual({ n: 39 }); // writes apply in call order
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('does not poison the chain when an update throws', async () => {
    const dir = await makeTempDir();
    const file = new JsonFile<Counter>(path.join(dir, 'c.json'), counterSchema);
    await expect(
      file.update(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await file.update(() => ({ n: 1 }));
    expect(await file.read()).toEqual({ n: 1 });
  });

  it('backs up a corrupt file as *.corrupt-<ts>, logs, and treats it as missing', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'c.json');
    await fs.writeFile(target, '{ not json');
    const logger = recordingLogger();
    const file = new JsonFile<Counter>(target, counterSchema, { logger });
    expect(await file.read()).toBeNull();
    const names = await fs.readdir(dir);
    const backup = names.find((n) => /^c\.json\.corrupt-\d+$/.test(n));
    expect(backup).toBeDefined();
    expect(await fs.readFile(path.join(dir, backup as string), 'utf8')).toBe('{ not json');
    expect(names).not.toContain('c.json');
    expect(logger.messages).toHaveLength(1);
    // A fresh write works afterwards.
    await file.write({ n: 5 });
    expect(await file.read()).toEqual({ n: 5 });
  });

  it('treats schema-invalid content as corrupt too', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'c.json');
    await fs.writeFile(target, JSON.stringify({ n: 'nope' }));
    const file = new JsonFile<Counter>(target, counterSchema, { logger: recordingLogger() });
    expect(await file.read()).toBeNull();
    expect((await fs.readdir(dir)).some((n) => n.includes('.corrupt-'))).toBe(true);
  });

  it('writes with the requested mode', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 's.json');
    await new JsonFile<Counter>(target, counterSchema, { mode: 0o600 }).write({ n: 1 });
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });
});

describe('paths', () => {
  it('creates the plan §3.5 tree', async () => {
    const root = path.join(await makeTempDir(), 'nested', 'data');
    const paths = await ensureDataDir(root);
    for (const sub of [paths.root, paths.chatsDir, paths.attachmentsDir, paths.cacheDir]) {
      expect((await fs.stat(sub)).isDirectory()).toBe(true);
    }
    await ensureDataDir(root); // idempotent
  });

  it('expands ~', () => {
    expect(expandHome('~')).toBe(os.homedir());
    expect(expandHome('~/code/x')).toBe(path.join(os.homedir(), 'code/x'));
    expect(expandHome('~other/x')).toBe('~other/x');
    expect(expandHome('/abs/~')).toBe('/abs/~');
  });

  it('resolveDataDir: OPENVERN_DATA_DIR wins over the argument', async () => {
    const base = await makeTempDir();
    const fromEnv = path.join(base, 'env');
    const prev = process.env.OPENVERN_DATA_DIR;
    try {
      process.env.OPENVERN_DATA_DIR = fromEnv;
      expect(await resolveDataDir(path.join(base, 'arg'))).toBe(fromEnv);
      expect((await fs.stat(dataPaths(fromEnv).chatsDir)).isDirectory()).toBe(true);
      delete process.env.OPENVERN_DATA_DIR;
      expect(await resolveDataDir(path.join(base, 'arg'))).toBe(path.join(base, 'arg'));
      await expect(resolveDataDir()).rejects.toThrow();
    } finally {
      if (prev === undefined) delete process.env.OPENVERN_DATA_DIR;
      else process.env.OPENVERN_DATA_DIR = prev;
    }
  });
});
