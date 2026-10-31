import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
