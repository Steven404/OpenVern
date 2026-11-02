// The edit tools against G1's real change service (not the in-memory fake).
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChangesService } from '../changes';
import { getProjectTools } from './index';
import { createFixture, type Fixture } from './test-fixture';

let fx: Fixture;
let data: string;
beforeAll(async () => {
  fx = await createFixture();
  data = await mkdtemp(path.join(tmpdir(), 'openvern-data-'));
});
afterAll(async () => {
  await fx.cleanup();
  await rm(data, { recursive: true, force: true });
});

describe('edit tools with the real ChangesService', () => {
  it('stages, reads through the overlay and leaves the disk alone', async () => {
    const svc = createChangesService({ dataDir: data });
    const changes = svc.tools({ chatId: 'chat1', projectRoot: fx.root, messageId: 'm1' });
    const ctx = { ...fx.ctx, changes };
    const t = (n: string) => getProjectTools().find((x) => x.spec.name === n);
    const e = await t('edit_file')?.run({ path: 'README.md', old_string: '# Fixture', new_string: '# Real' }, ctx);
    expect(e?.ok).toBe(true);
    expect(e?.output).toContain('+# Real');
    const r = await t('read_file')?.run({ path: 'README.md' }, ctx);
    expect(r?.output).toContain('# Real');
    expect(await readFile(path.join(fx.root, 'README.md'), 'utf8')).toContain('# Fixture');
    const bad = await t('write_file')?.run({ path: 'x.txt', content: 'k «redacted:abc»' }, ctx);
    expect(bad?.ok).toBe(false);
    const got = await svc.get('chat1');
    expect(got.pending?.files.map((f) => f.path)).toEqual(['README.md']);
  });
});
