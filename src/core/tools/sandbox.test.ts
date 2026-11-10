import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as sandbox from './sandbox';
import { BLOCKED_MESSAGE, isDeniedPath, OUTSIDE_MESSAGE, resolveInProject } from './sandbox';
import { createFixture, type Fixture } from './test-fixture';

let fx: Fixture;
beforeAll(async () => {
  fx = await createFixture();
});
afterAll(async () => {
  await fx.cleanup();
});

describe('resolveInProject', () => {
  it('resolves relative paths and the root itself', async () => {
    const res = await resolveInProject(fx.root, 'src/index.ts');
    expect(res).toMatchObject({ ok: true, rel: 'src/index.ts', exists: true });
    expect(await resolveInProject(fx.root, '.')).toMatchObject({ ok: true, rel: '' });
    expect(await resolveInProject(fx.root, '')).toMatchObject({ ok: true, rel: '' });
    expect(await resolveInProject(fx.root, './src/../src/index.ts')).toMatchObject({ ok: true, rel: 'src/index.ts' });
  });

  it('accepts absolute paths that are inside the root', async () => {
    const res = await resolveInProject(fx.root, path.join(fx.root, 'README.md'));
    expect(res).toMatchObject({ ok: true, rel: 'README.md' });
  });

  it('reports missing paths as ok with exists=false', async () => {
    expect(await resolveInProject(fx.root, 'nope/file.ts')).toMatchObject({ ok: true, exists: false });
  });

  it('rejects .. escapes and absolute paths outside the root', async () => {
    for (const p of ['..', '../outside/secret.txt', 'src/../../outside/secret.txt', '/etc/passwd', fx.outside]) {
      expect(await resolveInProject(fx.root, p)).toMatchObject({
        ok: false,
        kind: 'outside',
        message: OUTSIDE_MESSAGE,
      });
    }
  });

  it('does not treat a sibling folder sharing the root prefix as inside', async () => {
    expect(await resolveInProject(fx.root, `${fx.root}-evil/file`)).toMatchObject({ ok: false, kind: 'outside' });
  });

  it('rejects symlinks whose real path leaves the root', async () => {
    expect(await resolveInProject(fx.root, 'link-out-file')).toMatchObject({ ok: false, message: OUTSIDE_MESSAGE });
    expect(await resolveInProject(fx.root, 'link-out-dir')).toMatchObject({ ok: false, message: OUTSIDE_MESSAGE });
    expect(await resolveInProject(fx.root, 'link-out-dir/inner.txt')).toMatchObject({
      ok: false,
      message: OUTSIDE_MESSAGE,
    });
  });

  it('allows symlinks that stay inside the root and reports the real path', async () => {
    expect(await resolveInProject(fx.root, 'link-in')).toMatchObject({ ok: true, rel: 'src/index.ts' });
  });

  it('blocks a symlink that points at a denied file', async () => {
    expect(await resolveInProject(fx.root, 'link-env')).toMatchObject({
      ok: false,
      kind: 'blocked',
      message: BLOCKED_MESSAGE,
    });
  });

  it('rejects NUL bytes', async () => {
    expect(await resolveInProject(fx.root, 'a\0b')).toMatchObject({ ok: false, kind: 'invalid' });
  });

  it('fails cleanly when the project folder is missing', async () => {
    expect(await resolveInProject(path.join(fx.root, 'does-not-exist'), 'x')).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
  });
});

describe('deny list', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    'apps/web/.env',
    'a/b/server.pem',
    'x.key',
    'cert.p12',
    'id_rsa',
    'id_rsa.pub',
    'id_ed25519',
    '.git/config',
    '.git',
    'sub/.git/HEAD',
    '.ENV',
    'id_ecdsa',
    'id_ecdsa.pub',
    'id_ecdsa_sk',
    'id_dsa',
    '.git-credentials',
    '.netrc',
    '_netrc',
    'a/.NETRC',
  ])('blocks %s', (p) => {
    expect(isDeniedPath(p)).toBe(true);
  });

  it.each([
    '.env.example',
    '.env.sample',
    'src/.env.example',
    'README.md',
    'env.ts',
    '.gitignore',
    '.github/workflows/ci.yml',
    'keyboard.ts',
    '.npmrc',
    '.docker/config.json',
    'identity.ts',
  ])('allows %s', (p) => {
    expect(isDeniedPath(p)).toBe(false);
  });

  it('blocks denied files through resolveInProject but allows .env.example', async () => {
    for (const p of [
      '.env',
      '.env.local',
      'certs/server.pem',
      'certs/server.key',
      'certs/server.p12',
      'ssh/id_rsa',
      'ssh/id_ed25519',
      '.git/config',
    ]) {
      expect(await resolveInProject(fx.root, p)).toMatchObject({
        ok: false,
        kind: 'blocked',
        message: BLOCKED_MESSAGE,
      });
    }
    expect(await resolveInProject(fx.root, '.env.example')).toMatchObject({ ok: true });
    expect(await resolveInProject(fx.root, '.env.sample')).toMatchObject({ ok: true });
  });
});

describe('isDeniedRel', () => {
  let base: string;
  beforeAll(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'openvern-rel-')));
    await mkdir(path.join(base, 'x', '.ssh'), { recursive: true });
    await writeFile(path.join(base, 'x', '.ssh', 'config'), 'Host *\n');
    await writeFile(path.join(base, 'ok.txt'), 'ok\n');
    await symlink(path.join(base, 'x', '.ssh'), path.join(base, 'link'));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const isDeniedRel = (r: string) => r.split('/').includes('.ssh');

  it('blocks a lexical match and a symlink whose real path matches', async () => {
    const blocked = { ok: false, kind: 'blocked', message: BLOCKED_MESSAGE };
    expect(await resolveInProject(base, 'x/.ssh/config', { isDeniedRel })).toMatchObject(blocked);
    expect(await resolveInProject(base, 'link/config', { isDeniedRel })).toMatchObject(blocked);
    expect(await resolveInProject(base, 'link/config')).toMatchObject({ ok: true, rel: 'x/.ssh/config' });
    expect(await resolveInProject(base, 'ok.txt', { isDeniedRel })).toMatchObject({ ok: true });
  });
});

describe('deniedRoots (S1-M1)', () => {
  let base: string;
  let proj: string;
  let data: string;
  beforeAll(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'openvern-b2-')));
    proj = path.join(base, 'proj');
    data = path.join(proj, '.dev-data');
    await mkdir(path.join(data, 'chats'), { recursive: true });
    await writeFile(path.join(proj, 'README.md'), '# readme\n');
    await writeFile(path.join(data, 'secrets.json'), '{"openrouter":"sk-or-SECRET"}');
    await writeFile(path.join(data, 'chats', 'x.json'), '{}');
    await symlink(data, path.join(proj, 'innocent'));
    await symlink(path.join(data, 'secrets.json'), path.join(proj, 'key.json'));
    await symlink(base, path.join(base, 'alias'));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const blocked = { ok: false, kind: 'blocked', message: BLOCKED_MESSAGE };

  it('blocks the data dir and everything below it, lexically and absolutely', async () => {
    for (const p of ['.dev-data/secrets.json', '.dev-data', './.dev-data/../.dev-data/chats', `${data}/secrets.json`]) {
      expect(await resolveInProject(proj, p, { deniedRoots: [data] }), p).toMatchObject(blocked);
    }
  });

  it('blocks symlinks into the data dir', async () => {
    for (const p of ['innocent/secrets.json', 'innocent', 'key.json']) {
      expect(await resolveInProject(proj, p, { deniedRoots: [data] }), p).toMatchObject(blocked);
    }
  });

  it('blocks everything when the project root itself is inside the data dir', async () => {
    expect(await resolveInProject(path.join(data, 'chats'), 'x.json', { deniedRoots: [data] })).toMatchObject(blocked);
    expect(await resolveInProject(path.join(data, 'chats'), '.', { deniedRoots: [data] })).toMatchObject(blocked);
  });

  it('still allows the rest of the project, also when the root is spelled through a symlinked parent', async () => {
    expect(await resolveInProject(proj, 'README.md', { deniedRoots: [data] })).toMatchObject({ ok: true });
    expect(await resolveInProject(proj, '.', { deniedRoots: [data] })).toMatchObject({ ok: true, rel: '' });
    const aliasProj = path.join(base, 'alias', 'proj');
    expect(await resolveInProject(aliasProj, '.dev-data/secrets.json', { deniedRoots: [data] })).toMatchObject(blocked);
    expect(
      await resolveInProject(aliasProj, `${aliasProj}/.dev-data/secrets.json`, { deniedRoots: [data] }),
    ).toMatchObject(blocked);
  });

  it('without deniedRoots a data dir is still denied by name, but other files stay ordinary', async () => {
    expect(await resolveInProject(proj, '.dev-data/secrets.json')).toMatchObject(blocked);
    expect(await resolveInProject(proj, 'README.md')).toMatchObject({ ok: true, exists: true });
  });
});

describe('AS-06 R4 pure name and spelling policy (platform injected)', () => {
  // The R4 signatures are reached through the namespace and these local types, so the file typechecks before the
  // product gains the trailing `platform` parameter and `sameFoldedRel`; only the tests that need them fail.
  type NamePolicy = (name: string, platform?: NodeJS.Platform) => boolean;
  type SameRel = (a: string, b: string, platform?: NodeJS.Platform) => boolean;
  const deniedPath = sandbox.isDeniedPath as NamePolicy;
  const deniedEntry = sandbox.isDeniedEntryName as NamePolicy;
  const r4 = sandbox as unknown as { sameFoldedRel?: SameRel };

  const aliases = ['secretſ.json', 'ſecrets.json', 'SECRETſ.JSON', 'id_rſa', '.git-credentialſ'];
  const nested = aliases.map((a) => `config/${a}`);

  it.each(aliases)('A6-P2-5 darwin denies the APFS alias %s', (name) => {
    expect(deniedPath(name, 'darwin')).toBe(true);
    expect(deniedPath(`config/${name}`, 'darwin'), 'as a nested segment').toBe(true);
  });
  it.each(aliases)('A6-P2-5 control: injected linux keeps exact matching and allows %s', (name) => {
    expect(deniedPath(name, 'linux')).toBe(false);
    expect(deniedPath(`config/${name}`, 'linux')).toBe(false);
  });

  it('A6-P2-6 control: the entry and path policies agree for every P2 name, injected and by default', () => {
    for (const name of [...aliases, ...['secrets.json', '.env.example', '.env.ſample', '.env.ｅxample', 'README.md']])
      for (const platform of ['darwin', 'linux'] as const) {
        expect.soft(deniedEntry(name, platform), `${name} ${platform}`).toBe(deniedPath(name, platform));
        expect.soft(deniedEntry(name), `${name} default`).toBe(deniedPath(name));
      }
    expect(nested.every((rel) => deniedPath(rel, 'linux') === deniedPath(rel.split('/')[1] ?? '', 'linux'))).toBe(true);
  });

  it('A6-P2-4 control: env exceptions stay per spelling on darwin, and old denials stay', () => {
    for (const name of ['.env.example', '.env.sample', '.ENV.EXAMPLE'])
      expect.soft(deniedPath(name, 'darwin'), `${name} allowed`).toBe(false);
    for (const name of ['.env.ſample', '.env.ｅxample', 'secrets.json', 'SECRETS.JSON', '.env', 'id_rsa'])
      expect.soft(deniedPath(name, 'darwin'), `${name} denied`).toBe(true);
  });

  it('A6-P3-5 sameFoldedRel: NFC + lower case off darwin; per-segment fold on darwin', () => {
    expect(typeof r4.sameFoldedRel, 'sameFoldedRel is exported').toBe('function');
    const same = r4.sameFoldedRel as SameRel;
    for (const platform of ['linux', 'win32'] as const) {
      expect.soft(same('Readme.md', 'README.md', platform), `${platform}: case`).toBe(true);
      expect.soft(same('dir/é.txt', 'dir/é.txt', platform), `${platform}: NFC/NFD`).toBe(true);
      expect.soft(same('poſt.txt', 'post.txt', platform), `${platform}: ſ/s`).toBe(false);
      expect.soft(same('straße.txt', 'strasse.txt', platform), `${platform}: ß/ss`).toBe(false);
      expect.soft(same('a/b.txt', 'a/c.txt', platform), `${platform}: different names`).toBe(false);
    }
    for (const [a, b] of [
      ['poſt.txt', 'post.txt'],
      ['straße.txt', 'strasse.txt'],
      ['notes/poſt.txt', 'Notes/post.txt'],
      ['Readme.md', 'README.md'],
      ['dir/é.txt', 'dir/é.txt'],
    ] as const) {
      expect.soft(same(a, b, 'darwin'), `darwin ${a} ~ ${b}`).toBe(true);
      expect.soft(same(b, a, 'darwin'), `darwin ${b} ~ ${a}`).toBe(true);
    }
    expect.soft(same('a/post.txt', 'post.txt', 'darwin'), 'different segment counts').toBe(false);
    expect.soft(same('a/post.txt', 'b/poſt.txt', 'darwin'), 'different directories').toBe(false);
    expect.soft(same('post.txt', 'past.txt', 'darwin'), 'different names').toBe(false);
  });
});
