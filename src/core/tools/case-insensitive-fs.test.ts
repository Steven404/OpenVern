// AS-06 characterization: the tool sandbox and the changes apply path on case- and normalization-insensitive volumes
// (APFS default). Filesystem-dependent tests detect the volume's behaviour at runtime and skip elsewhere, but on macOS
// a skip is a gate failure: `requireInsensitive` / `requireUnicodeAliases` throw instead of skipping there.

import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptAll, createChangesService } from '../changes';
import { defaultDataDirRoots } from '../index';
import { createProjectFilesService } from '../project-files';
import { isHomeDeniedRel } from '../project-files/home-deny';
import { cleanupTempDirs, makeStorage } from '../storage/test-helpers';
import { getProjectTools, renderTree } from './index';
import {
  BLOCKED_MESSAGE,
  isWithinAny,
  OUTSIDE_MESSAGE,
  resolveForWrite,
  resolveInProject,
  type SandboxOptions,
} from './sandbox';
import type { ToolContext } from './types';
import { walk } from './walk';

// Removes every dir made by `makeStorage` / `makeTempDir` after each test (they live outside `root`).
cleanupTempDirs();

const isMac = process.platform === 'darwin';

let root: string;
let insensitive = false;
let unicodeAliases = false;
beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'openvern-case-')));
  await writeFile(path.join(root, 'probe'), 'probe');
  insensitive = await exists(path.join(root, 'PROBE'));
  await writeFile(path.join(root, 'probe-é'), 'probe');
  unicodeAliases = await exists(path.join(root, 'probe-é'.normalize('NFD')));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

type SkipCtx = { skip: () => void };

/** Skips on case-sensitive volumes, except on macOS, where every AS-06 filesystem test must execute. */
function requireInsensitive(ctx: SkipCtx): void {
  if (insensitive) return;
  if (isMac) throw new Error('macOS gate: the temp volume is case-sensitive, so AS-06 case tests cannot execute');
  ctx.skip();
}

/** Skips when NFC and NFD spellings are distinct names, except on macOS (gate). */
function requireUnicodeAliases(ctx: SkipCtx): void {
  if (unicodeAliases) return;
  if (isMac)
    throw new Error('macOS gate: the temp volume is normalization-sensitive, so AS-06 Unicode tests cannot run');
  ctx.skip();
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function put(dir: string, rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), content);
}

/** Entries of `dir` whose case-folded NFC name equals `name` case-folded (what a case-insensitive volume would alias). */
async function aliasesOf(dir: string, name: string): Promise<string[]> {
  const fold = (s: string) => s.normalize('NFC').toLowerCase();
  return (await readdir(dir)).filter((e) => fold(e) === fold(name));
}

function tools(opts: SandboxOptions = {}) {
  const all = getProjectTools(opts);
  return (name: string) => {
    const t = all.find((x) => x.spec.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
}

/** A real ChangesService and a tool context bound to it, so edit tools reach the sandbox (not "no changes"). */
async function realContext(projectRoot: string, label: string, sandbox?: SandboxOptions) {
  const dataDir = path.join(root, `${label}-data`);
  await mkdir(dataDir, { recursive: true });
  const svc = createChangesService({ dataDir, sandbox });
  const changes = svc.tools({ chatId: label, projectRoot, messageId: 'm' });
  const ctx: ToolContext = { projectRoot, signal: new AbortController().signal, changes };
  return { svc, changes, ctx };
}

describe('AS-06 macOS gate', () => {
  it('detects a case- and normalization-insensitive temp volume on macOS (no silent skips)', (ctx) => {
    if (!isMac) ctx.skip();
    expect({ insensitive, unicodeAliases }).toEqual({ insensitive: true, unicodeAliases: true });
  });
});

describe('T1 case variants of denied names, through the real tools', () => {
  const variants = ['.ENV', 'Secrets.JSON', '.Git/config', 'ID_RSA'];
  const layouts = {
    // On-disk lowercase, requested in variant case.
    lower: ['.env', 'secrets.json', '.git/config', 'id_rsa'],
    // On-disk variant case, requested in variant case and lowercase.
    upper: variants,
  };

  for (const [layout, onDisk] of Object.entries(layouts)) {
    it(`refuses read, list, search and write (${layout}-case files on disk)`, async () => {
      const proj = path.join(root, `t1-${layout}`);
      for (const rel of onDisk) await put(proj, rel, 'NEEDLE secret dummy\n');
      await put(proj, 'README.md', 'NEEDLE control\n');
      const { svc, ctx } = await realContext(proj, `t1-${layout}`);
      const t = tools();
      const requested = [...variants, ...layouts.lower];

      for (const rel of requested) {
        const read = await t('read_file').run({ path: rel }, ctx);
        expect(read, `read_file ${rel}`).toMatchObject({ ok: false, output: BLOCKED_MESSAGE });
        const top = rel.split('/')[0] as string;
        const search = await t('search').run({ query: 'NEEDLE', path: rel }, ctx);
        expect(search, `search in ${rel}`).toMatchObject({ ok: false, output: BLOCKED_MESSAGE });
        const list = await t('list_files').run({ path: top }, ctx);
        expect(list, `list_files ${top}`).toMatchObject({ ok: false, output: BLOCKED_MESSAGE });
        const write = await t('write_file').run({ path: rel, content: 'overwrite\n' }, ctx);
        expect(write, `write_file ${rel}`).toMatchObject({ ok: false, output: BLOCKED_MESSAGE });
      }

      // Controls: the same context reads, lists, searches and stages allowed paths.
      expect(await t('read_file').run({ path: 'README.md' }, ctx)).toMatchObject({ ok: true });
      if (insensitive) {
        const variantRead = await t('read_file').run({ path: 'readme.MD' }, ctx);
        expect(variantRead.ok, 'a case variant of an allowed file resolves on this volume').toBe(true);
        expect(variantRead.output).toContain('NEEDLE control');
      }
      const listing = await t('list_files').run({ path: '.', depth: 3 }, ctx);
      expect(listing.ok).toBe(true);
      expect(listing.output).toContain('README.md');
      for (const name of ['.env', 'secrets.json', '.git', 'id_rsa']) {
        expect(listing.output.toLowerCase(), `listing hides ${name}`).not.toContain(name);
      }
      const found = await t('search').run({ query: 'NEEDLE' }, ctx);
      expect(found.ok).toBe(true);
      expect(found.output).toContain('README.md');
      expect(found.output).not.toContain('secret dummy');
      expect(await t('write_file').run({ path: 'notes.txt', content: 'allowed\n' }, ctx)).toMatchObject({ ok: true });

      expect((await svc.get(`t1-${layout}`)).pending?.files.map((f) => f.path)).toEqual(['notes.txt']);
      for (const rel of onDisk) expect(await readFile(path.join(proj, rel), 'utf8')).toBe('NEEDLE secret dummy\n');
      expect(await exists(path.join(proj, 'notes.txt')), 'staging never writes the disk').toBe(false);
    });
  }

  it('the home layer refuses .SSH/config in every case; projects have no blanket .ssh deny', async () => {
    const home = path.join(root, 't1-fake-home');
    await put(home, '.ssh/config', 'Host dummy\n');
    await put(home, 'notes.txt', 'allowed\n');
    const { ctx } = await realContext(home, 't1-home');
    const h = tools({ isDeniedRel: isHomeDeniedRel });
    for (const rel of ['.SSH/config', '.ssh/config', '.Ssh/CONFIG']) {
      expect(await h('read_file').run({ path: rel }, ctx), `read ${rel}`).toMatchObject({
        ok: false,
        output: BLOCKED_MESSAGE,
      });
      expect(await h('write_file').run({ path: rel, content: 'x\n' }, ctx), `write ${rel}`).toMatchObject({
        ok: false,
        output: BLOCKED_MESSAGE,
      });
    }
    expect(await h('list_files').run({ path: '.SSH' }, ctx)).toMatchObject({ ok: false, output: BLOCKED_MESSAGE });
    expect(await h('search').run({ query: 'Host', path: '.SSH' }, ctx)).toMatchObject({
      ok: false,
      output: BLOCKED_MESSAGE,
    });
    expect(await h('read_file').run({ path: 'notes.txt' }, ctx)).toMatchObject({ ok: true });
    // Projects legitimately hold `.ssh/` folders: only the home layer denies them.
    expect(await tools()('read_file').run({ path: '.ssh/config' }, ctx)).toMatchObject({ ok: true });
  });
});

describe('T2 case variants of an existing denied root', () => {
  it('blocks existing denied roots through case variants and symlinks', async (ctx) => {
    requireInsensitive(ctx);
    const denied = path.join(root, 'Library', 'Application Support', 'openvern');
    await mkdir(denied, { recursive: true });
    await writeFile(path.join(denied, 'note.txt'), 'dummy');
    await writeFile(path.join(root, 'Library', 'Application Support', 'other.txt'), 'allowed');
    await symlink(denied, path.join(root, 'alias'));
    const opts = { deniedRoots: [denied] };
    for (const target of ['library/application support/OPENVERN/note.txt', 'alias/note.txt']) {
      expect(await resolveInProject(root, target, opts), target).toMatchObject({ ok: false, kind: 'blocked' });
    }
    expect(
      await tools(opts)('read_file').run(
        { path: 'LIBRARY/Application Support/OpenVern/note.txt' },
        {
          projectRoot: root,
          signal: new AbortController().signal,
        },
      ),
    ).toMatchObject({ ok: false, output: BLOCKED_MESSAGE });
    // Controls: the variant resolves to the canonical file without the policy, and a sibling stays allowed with it.
    expect(await resolveInProject(root, 'library/application support/OPENVERN/note.txt')).toMatchObject({
      ok: true,
      rel: 'Library/Application Support/openvern/note.txt',
    });
    expect(await resolveInProject(root, 'library/application support/OTHER.txt', opts)).toMatchObject({
      ok: true,
      rel: 'Library/Application Support/other.txt',
    });
  });
});

describe('T3 a not-yet-existing denied root (B13)', () => {
  it('blocks a missing denied root reached through a symlinked ancestor, exact case (portable)', async () => {
    const parent = path.join(root, 'Exact', 'Application Support');
    await mkdir(parent, { recursive: true });
    await symlink(parent, path.join(root, 'exact-alias'));
    const denied = path.join(parent, 'openvern');
    expect(await exists(denied)).toBe(false);
    const opts = { deniedRoots: [denied] };
    expect(await resolveForWrite(root, 'exact-alias/other/new.txt', opts), 'control').toMatchObject({
      ok: true,
      rel: 'Exact/Application Support/other/new.txt',
    });
    expect(await resolveForWrite(root, 'exact-alias/openvern/new.txt', opts)).toMatchObject({
      ok: false,
      kind: 'blocked',
    });
  });

  it('blocks a missing denied root after canonicalizing an existing ancestor (symlink + case variant)', async (ctx) => {
    requireInsensitive(ctx);
    const parent = path.join(root, 'Future', 'Application Support');
    await mkdir(parent, { recursive: true });
    await symlink(parent, path.join(root, 'future-alias'));
    const denied = path.join(parent, 'openvern');
    await expect(stat(denied)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await resolveForWrite(root, 'future-alias/OPENVERN/new.txt', { deniedRoots: [denied] })).toMatchObject({
      ok: false,
      kind: 'blocked',
    });
  });

  it('blocks missing denied roots spelled with different case without a symlink (resolveForWrite)', async (ctx) => {
    requireInsensitive(ctx);
    const denied = path.join(root, 'missing-data');
    const opts = { deniedRoots: [denied] };
    expect(await resolveForWrite(root, 'other-missing/new.txt', opts), 'control').toMatchObject({ ok: true });
    expect(await resolveForWrite(root, 'missing-data/new.txt', opts), 'exact case').toMatchObject({
      ok: false,
      kind: 'blocked',
    });
    expect(await resolveForWrite(root, 'MISSING-DATA/new.txt', opts)).toMatchObject({ ok: false, kind: 'blocked' });
  });

  it('rejects staging into a case variant of a missing denied root (real ChangesService, no symlink)', async (ctx) => {
    requireInsensitive(ctx);
    const proj = path.join(root, 't3-stage');
    await mkdir(proj);
    const denied = path.join(proj, 'stage-data');
    const sandbox = { deniedRoots: [denied] };
    const { svc, changes, ctx: toolCtx } = await realContext(proj, 't3-stage', sandbox);

    const staged = await changes.stage('STAGE-DATA/new.txt', 'dummy\n').then(
      () => 'accepted',
      (e: unknown) => (e as { code?: string }).code ?? 'error',
    );
    const tool = await tools(sandbox)('write_file').run({ path: 'Stage-Data/tool.txt', content: 'dummy\n' }, toolCtx);
    // Control: an allowed missing path is staged by the same service.
    await changes.stage('stage-ok/new.txt', 'ok\n');
    const pending = (await svc.get('t3-stage')).pending?.files.map((f) => f.path);
    const created = await aliasesOf(proj, 'stage-data');

    expect.soft(staged, 'ChangesService.stage').toBe('path_invalid');
    expect.soft(tool, 'write_file tool').toMatchObject({ ok: false, output: BLOCKED_MESSAGE });
    expect.soft(pending, 'pending proposals').toEqual(['stage-ok/new.txt']);
    expect.soft(created, 'nothing on disk under the denied root').toEqual([]);
  });

  it('revalidates a staged missing root against a changed policy on apply', async (ctx) => {
    requireInsensitive(ctx);
    const proj = path.join(root, 't3-apply');
    await mkdir(proj);
    const dataDir = path.join(root, 't3-apply-data');
    await mkdir(dataDir);
    const denied = path.join(proj, 'apply-data');
    // Staged while the root was not denied, so this test reaches apply even once staging rejects the variant.
    const open = createChangesService({ dataDir });
    const openTools = open.tools({ chatId: 'apply', projectRoot: proj, messageId: 'm' });
    await openTools.stage('APPLY-DATA/new.txt', 'dummy\n');
    await openTools.stage('apply-ok.txt', 'control\n');
    const pending = (await open.get('apply')).pending;
    if (!pending) throw new Error('Expected a pending proposal');
    expect(pending.files.map((f) => f.path)).toEqual(['APPLY-DATA/new.txt', 'apply-ok.txt']);

    const restricted = createChangesService({ dataDir, sandbox: { deniedRoots: [denied] } });
    const result = await restricted
      .apply({ chatId: 'apply', projectRoot: proj, revision: pending.revision, decisions: acceptAll(pending) })
      .then(
        ({ batch }) => ({ written: batch.written.map((f) => f.path), conflicts: batch.conflicts }),
        (error: unknown) => ({ error: (error as { code?: string }).code ?? String(error) }),
      );
    const createdDirs = await aliasesOf(proj, 'apply-data');
    const fileWritten = await exists(path.join(denied, 'new.txt'));

    expect.soft(fileWritten, 'apply must not create a file under the denied root').toBe(false);
    expect.soft(createdDirs, 'apply must not create the denied root').toEqual([]);
    expect.soft(result, 'apply outcome').toEqual({
      written: ['apply-ok.txt'],
      conflicts: [{ path: 'APPLY-DATA/new.txt', reason: 'blocked' }],
    });
    expect
      .soft(await readFile(path.join(proj, 'apply-ok.txt'), 'utf8').catch(() => null), 'control written')
      .toBe('control\n');
  });
});

describe('T4 NFC and NFD spellings', () => {
  it('canonicalizes Unicode filename and directory aliases', async (ctx) => {
    requireUnicodeAliases(ctx);
    const composed = 'café';
    const decomposed = composed.normalize('NFD');
    await mkdir(path.join(root, composed));
    await writeFile(path.join(root, composed, `${composed}.txt`), 'dummy');
    const canonical = await resolveInProject(root, `${composed}/${composed}.txt`);
    const variant = await resolveInProject(root, `${decomposed}/${decomposed}.txt`);
    expect(canonical.ok).toBe(true);
    expect(variant).toMatchObject({ ok: true, rel: canonical.ok ? canonical.rel : '' });
    expect(
      await resolveInProject(root, `${decomposed}/${decomposed}.txt`, {
        deniedRoots: [await realpath(path.join(root, composed))],
      }),
    ).toMatchObject({ ok: false, kind: 'blocked' });
  });

  for (const form of ['NFC', 'NFD'] as const) {
    it(`stages one canonical record for a file created in ${form} and applies only through it`, async (ctx) => {
      requireUnicodeAliases(ctx);
      const proj = path.join(root, `t4-${form}`);
      const dirName = 'résumé'.normalize(form);
      const fileName = 'naïve.txt'.normalize(form);
      await put(proj, `${dirName}/${fileName}`, 'original\n');
      // Measure what the volume stored instead of assuming a form.
      const [diskDir, ...extraDirs] = await readdir(proj);
      const [diskFile, ...extraFiles] = await readdir(path.join(proj, dirName));
      expect({ extraDirs, extraFiles }).toEqual({ extraDirs: [], extraFiles: [] });
      const diskRel = `${diskDir}/${diskFile}`;
      const before = await stat(path.join(proj, diskRel));

      // Stage through the stored spelling first, then through the other normalization form of it.
      const asCreated = diskRel;
      const alias = diskRel.normalize(diskRel.normalize('NFC') === diskRel ? 'NFD' : 'NFC');
      expect(alias).not.toBe(diskRel);
      expect(await resolveInProject(proj, alias)).toMatchObject({ ok: true, rel: diskRel });

      const { svc, changes } = await realContext(proj, `t4-${form}`);
      await changes.stage(asCreated, 'first\n');
      const second = await changes.stage(alias, 'second\n').then(
        () => 'accepted',
        (e: unknown) => (e as { code?: string }).code ?? 'error',
      );
      const pending = (await svc.get(`t4-${form}`)).pending;
      if (!pending) throw new Error('Expected a pending proposal');
      expect(['accepted', 'path_invalid']).toContain(second);
      expect(
        pending.files.map((f) => f.path),
        'one canonical record',
      ).toEqual([diskRel]);

      const { batch } = await svc.apply({
        chatId: `t4-${form}`,
        projectRoot: proj,
        revision: pending.revision,
        decisions: acceptAll(pending),
      });
      expect(batch.written.map((f) => f.path)).toEqual([diskRel]);
      expect(batch.conflicts).toEqual([]);
      expect(await readdir(proj)).toEqual([diskDir]);
      expect(await readdir(path.join(proj, diskDir as string))).toEqual([diskFile]);
      const after = await lstat(path.join(proj, diskRel));
      expect(after.nlink, 'no second link to the inode').toBe(1);
      expect(after.dev).toBe(before.dev);
      expect(await readFile(path.join(proj, diskRel), 'utf8')).toBe(second === 'accepted' ? 'second\n' : 'first\n');
    });
  }

  it('blocks a missing denied root whose existing parent is stored in the other normalization form', async (ctx) => {
    requireUnicodeAliases(ctx);
    const proj = path.join(root, 't4-home');
    const user = 'josé';
    await mkdir(path.join(proj, user.normalize('NFD')), { recursive: true });
    // Measure the stored spelling; the denied root is spelled in the other form (e.g. an NFC $HOME over an NFD
    // folder), lexically, as AS-05 keeps roots that don't exist yet.
    const [disk = ''] = await readdir(proj);
    const spelled = disk.normalize(disk.normalize('NFC') === disk ? 'NFD' : 'NFC');
    expect(spelled).not.toBe(disk);
    const denied = path.join(proj, spelled, 'openvern');
    const sandbox = { deniedRoots: [denied] };
    const nfd = `${disk}/openvern/projects.json`;
    const nfc = `${spelled}/openvern/projects.json`;
    expect(await resolveForWrite(proj, nfc, sandbox), 'root spelling').toMatchObject({ ok: false, kind: 'blocked' });
    expect(await resolveForWrite(proj, `${disk}/other.txt`, sandbox), 'control').toMatchObject({ ok: true });

    const { svc, changes } = await realContext(proj, 't4-home', sandbox);
    const write = await resolveForWrite(proj, nfd, sandbox);
    const staged = await changes.stage(nfd, '[]\n').then(
      () => 'accepted',
      (e: unknown) => (e as { code?: string }).code ?? 'error',
    );
    expect.soft(write, 'resolveForWrite stored spelling').toMatchObject({ ok: false, kind: 'blocked' });
    expect.soft(staged, 'ChangesService.stage stored spelling').toBe('path_invalid');
    expect.soft((await svc.get('t4-home')).pending, 'no pending proposal').toBeNull();
  });
});

describe('T5 staging a case variant of an existing file', () => {
  it('records the canonical file once and applies only through it', async (ctx) => {
    requireInsensitive(ctx);
    const proj = path.join(root, 't5');
    await put(proj, 'README.md', 'original\n');
    const { svc, changes } = await realContext(proj, 't5');
    await changes.stage('README.md', 'first\n');
    await expect(changes.stage('readme.md', 'second\n')).rejects.toMatchObject({
      code: 'path_invalid',
      message: expect.stringContaining('on-disk spelling "README.md"'),
    });
    const pending = (await svc.get('t5')).pending;
    if (!pending) throw new Error('Expected a pending proposal');
    expect(pending.files.map((f) => f.path)).toEqual(['README.md']);
    await svc.apply({ chatId: 't5', projectRoot: proj, revision: pending.revision, decisions: acceptAll(pending) });
    expect(await readdir(proj)).toEqual(['README.md']);
    expect(await readFile(path.join(proj, 'README.md'), 'utf8')).toBe('first\n');
  });
});

describe('T6 duplicate project roots that differ only in case', () => {
  let storageDir = '';
  it('rejects the second root as a conflict', async (ctx) => {
    requireInsensitive(ctx);
    const dir = path.join(root, 'Proj');
    await mkdir(dir);
    const { dataDir, storage } = await makeStorage();
    storageDir = path.dirname(dataDir);
    await storage.projects.create({ rootPath: dir });
    await expect(storage.projects.create({ rootPath: path.join(root, 'proj') })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await storage.projects.list()).toHaveLength(1);
  });

  it('removed the storage temp dir after the test (no fixture leak)', async (ctx) => {
    requireInsensitive(ctx);
    expect(storageDir).not.toBe('');
    expect(await exists(storageDir)).toBe(false);
  });
});

describe('T7 symlinked system roots (/var -> /private/var, /tmp -> /private/tmp)', () => {
  const owned: string[] = [];
  afterAll(async () => {
    await Promise.all(owned.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('maps a symlinked project root and absolute paths to the real root (portable)', async () => {
    const target = path.join(root, 'root-target');
    await mkdir(target);
    await writeFile(path.join(target, 'note.txt'), 'dummy');
    const alias = path.join(root, 'root-alias');
    await symlink(target, alias);
    expect(await resolveInProject(alias, path.join(alias, 'note.txt'))).toMatchObject({
      ok: true,
      rel: 'note.txt',
      abs: path.join(target, 'note.txt'),
    });
  });

  for (const [link, real, base] of [
    [
      '/var',
      '/private/var',
      async () => ((await realpath(tmpdir())).startsWith('/private/var/') ? tmpdir() : '/var/tmp'),
    ],
    ['/tmp', '/private/tmp', async () => '/tmp'],
  ] as const) {
    it(`maps ${link} spellings of a self-owned temp project onto ${real}`, async (ctx) => {
      const isLink = await lstat(link).then(
        (s) => s.isSymbolicLink(),
        () => false,
      );
      const target = isLink ? await realpath(link) : '';
      if (target !== real) {
        if (isMac) throw new Error(`macOS gate: ${link} is not a symlink to ${real}`);
        ctx.skip();
      }
      const realBase = await realpath(await mkdtemp(path.join(await base(), 'openvern-t7-')));
      owned.push(realBase);
      expect(realBase.startsWith(`${real}/`), `${realBase} lies under ${real}`).toBe(true);
      const aliasBase = `${link}${realBase.slice(real.length)}`;
      const realRoot = path.join(realBase, 'proj');
      const aliasRoot = path.join(aliasBase, 'proj');
      await put(realRoot, 'note.txt', 'dummy\n');
      await put(realRoot, '.env', 'dummy\n');
      await put(realRoot, 'data/x.txt', 'dummy\n');
      await put(realBase, 'outside.txt', 'dummy\n');
      const deny = { deniedRoots: [path.join(realRoot, 'data')] };
      const note = { ok: true, rel: 'note.txt', abs: path.join(realRoot, 'note.txt'), root: realRoot };

      expect(await resolveInProject(aliasRoot, 'note.txt')).toMatchObject(note);
      expect(await resolveInProject(aliasRoot, path.join(aliasRoot, 'note.txt'))).toMatchObject(note);
      expect(await resolveInProject(aliasRoot, path.join(realRoot, 'note.txt'))).toMatchObject(note);
      // A real (stored) root does not adopt the alias spelling: rejected as outside, never broadened.
      expect(await resolveInProject(realRoot, path.join(aliasRoot, 'note.txt'))).toMatchObject({
        ok: false,
        kind: 'outside',
        message: OUTSIDE_MESSAGE,
      });
      expect(await resolveInProject(aliasRoot, path.join(aliasBase, 'outside.txt'))).toMatchObject({
        ok: false,
        kind: 'outside',
      });
      for (const p of [path.join(aliasRoot, '.ENV'), path.join(aliasRoot, '.env')]) {
        expect(await resolveInProject(aliasRoot, p), p).toMatchObject({ ok: false, kind: 'blocked' });
      }
      for (const p of [path.join(aliasRoot, 'data/x.txt'), path.join(realRoot, 'data/x.txt')]) {
        expect(await resolveInProject(aliasRoot, p, deny), p).toMatchObject({ ok: false, kind: 'blocked' });
        expect(await resolveForWrite(aliasRoot, `${path.dirname(p)}/new.txt`, deny), p).toMatchObject({
          ok: false,
          kind: 'blocked',
        });
      }
      expect(await resolveForWrite(aliasRoot, path.join(aliasRoot, 'new/file.txt'))).toMatchObject({
        ok: true,
        exists: false,
        rel: 'new/file.txt',
        abs: path.join(realRoot, 'new/file.txt'),
      });
      const read = await tools()('read_file').run(
        { path: path.join(aliasRoot, 'note.txt') },
        { projectRoot: aliasRoot, signal: new AbortController().signal },
      );
      expect(read.ok).toBe(true);
      expect(read.output).toContain('dummy');
    });
  }
});

describe('T8 hardlinks', () => {
  it('blocks a hardlink to a denied file by inode', async () => {
    const proj = path.join(root, 't8');
    await mkdir(proj);
    const secret = path.join(proj, 'secrets.json');
    await writeFile(secret, 'dummy');
    await link(secret, path.join(proj, 'innocent.txt'));
    expect(await resolveInProject(proj, 'innocent.txt', { deniedFiles: [secret] })).toMatchObject({
      ok: false,
      kind: 'blocked',
    });
    if (insensitive) {
      expect(await resolveInProject(proj, 'INNOCENT.txt', { deniedFiles: [secret] })).toMatchObject({ ok: false });
    }
  });
});

describe('deniedRoots matching (pure, by platform)', () => {
  const denied = ['/Users/josé/Library/Application Support/openvern'];
  const variant = '/users/JOSÉ/library/application support/OpenVern/projects.json';

  it('keeps Linux matching exact (case- and normalization-sensitive)', () => {
    expect(isWithinAny(denied, `${denied[0]}/projects.json`, 'linux')).toBe(true);
    expect(isWithinAny(denied, variant, 'linux')).toBe(false);
    expect(isWithinAny(denied, denied[0]?.normalize('NFD') ?? '', 'linux')).toBe(false);
  });

  it('folds case and Unicode normalization on darwin (adds denials only)', () => {
    expect(isWithinAny(denied, variant, 'darwin')).toBe(true);
    expect(isWithinAny(denied, denied[0]?.normalize('NFD') ?? '', 'darwin')).toBe(true);
    // Never broader than containment: siblings, prefixes and parents stay outside.
    expect(isWithinAny(denied, '/Users/josé/Library/Application Support/openvern-other/x', 'darwin')).toBe(false);
    expect(isWithinAny(denied, '/Users/josé/Library/Application Support', 'darwin')).toBe(false);
    expect(isWithinAny([], variant, 'darwin')).toBe(false);
    expect(isWithinAny(undefined, variant, 'darwin')).toBe(false);
  });

  it('over-denies a distinct case-variant folder on case-sensitive APFS (accepted fail-safe tradeoff)', () => {
    // On a case-sensitive volume `/Volumes/cs/OPENVERN` is a different folder from the denied `/Volumes/cs/openvern`;
    // darwin matching denies it anyway. This is a path-only check: it makes no claim about the volume.
    expect(isWithinAny(['/Volumes/cs/openvern'], '/Volumes/cs/OPENVERN/notes.txt', 'darwin')).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------- review remediation
// P1: a denied root that does not exist yet, reached through a Unicode full case-fold alias that APFS treats as the
// same name (`s`/`ſ`, `ss`/`ß`, `σ`/`ς`, `ff`/`ﬀ`). P2: a denied root kept lexically (AS-05 keeps the spelling
// of a root that is missing) below a symlinked ancestor: the real `/tmp` -> `/private/tmp` alias and an owned
// symlinked home. Every scenario takes its roots from the production `defaultDataDirRoots`, in an owned temp dir, and
// drives the real tools, a real ChangesService and a real apply. Content is dummy text.

/** Plain and full-case-fold spellings that this Mac's APFS stores as one name (measured in `beforeAll`). */
const FOLD_FAMILIES = [
  ['s', 'ſ'],
  ['ss', 'ß'],
  ['σ', 'ς'],
  ['ff', 'ﬀ'],
] as const;

async function sameInode(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
  return x !== null && y !== null && x.ino === y.ino && x.dev === y.dev;
}

/** Shallowest directory of `relDir` (below `realRoot`) that doesn't exist, as an absolute path. */
async function shallowestMissing(realRoot: string, relDir: string): Promise<string | null> {
  let cur = realRoot;
  for (const seg of relDir.split('/').filter(Boolean)) {
    cur = path.join(cur, seg);
    if (!(await exists(cur))) return cur;
  }
  return null;
}

interface DeniedScenario {
  label: string;
  /** The folder registered as the project (may be a symlink spelling). */
  projectRoot: string;
  /** The roots exactly as the production supplier returned them. */
  deniedRoots: string[];
  /** The policy entry under attack: must be in `deniedRoots` and must not exist yet. */
  denied: string;
  /** Project-relative path the model proposes; its directory is `denied` under another spelling. */
  target: string;
  /** Symlinks the scenario set up (path -> `readlink` value); each must be unchanged after every step. */
  links?: Record<string, string>;
}

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'accepted',
    (e: unknown) => (e as { code?: string }).code ?? 'error',
  );

async function exerciseDeniedRoot(sc: DeniedScenario): Promise<void> {
  const realRoot = await realpath(sc.projectRoot);
  expect(sc.deniedRoots, 'the production supplier lists the attacked root').toContain(sc.denied);
  await expect(stat(sc.denied), 'the denied root does not exist yet').rejects.toMatchObject({ code: 'ENOENT' });
  const missing = await shallowestMissing(realRoot, path.posix.dirname(sc.target));
  if (missing === null) throw new Error('expected a missing directory on the way to the target');
  const deniedFiles = sc.deniedRoots.map((r) => path.join(r, 'secrets.json'));
  const sandbox: SandboxOptions = { deniedRoots: sc.deniedRoots, deniedFiles };
  const nothingCreated = async (step: string) => {
    expect.soft(await exists(missing), `${step}: ${missing} must not be created`).toBe(false);
    expect.soft(await exists(sc.denied), `${step}: the denied root must not be created`).toBe(false);
    // Repair a failed step so the next one starts from the same disk state.
    await rm(missing, { recursive: true, force: true });
  };
  const linksIntact = async (step: string) => {
    for (const [link, dest] of Object.entries(sc.links ?? {})) {
      expect.soft(await readlink(link), `${step}: ${link} still points at ${dest}`).toBe(dest);
    }
  };

  // 1. The policy is present when the model proposes the write.
  const a = `${sc.label}-a`;
  const { svc, changes, ctx } = await realContext(sc.projectRoot, a, sandbox);
  const write = await tools(sandbox)('write_file').run({ path: sc.target, content: 'owned dummy\n' }, ctx);
  const staged = await outcome(changes.stage(sc.target, 'owned dummy\n'));
  const direct = await resolveForWrite(sc.projectRoot, sc.target, sandbox);
  await changes.stage('control.txt', 'control\n');
  const pending = (await svc.get(a)).pending;
  if (!pending) throw new Error('Expected a pending proposal (control)');
  expect.soft(write, 'write_file').toMatchObject({ ok: false, output: BLOCKED_MESSAGE });
  expect.soft(staged, 'ChangesService.stage').toBe('path_invalid');
  expect.soft(direct, 'resolveForWrite').toMatchObject({ ok: false, kind: 'blocked' });
  expect
    .soft(
      pending.files.map((f) => f.path),
      'no forbidden pending proposal',
    )
    .toEqual(['control.txt']);
  const applied = await svc
    .apply({ chatId: a, projectRoot: sc.projectRoot, revision: pending.revision, decisions: acceptAll(pending) })
    .then(({ batch }) => ({ written: batch.written.map((f) => f.path), conflicts: batch.conflicts }));
  expect.soft(applied, 'apply (policy at stage)').toEqual({ written: ['control.txt'], conflicts: [] });
  expect(await readFile(path.join(realRoot, 'control.txt'), 'utf8'), 'control applied').toBe('control\n');
  await nothingCreated('policy at stage');
  await linksIntact('policy at stage');

  // 2. The policy arrives after staging: apply's own checks (before `mkdir` and the re-check after it) must refuse.
  const b = `${sc.label}-b`;
  const dataDir = path.join(root, `${b}-data`);
  await mkdir(dataDir);
  const open = createChangesService({ dataDir });
  const openTools = open.tools({ chatId: b, projectRoot: sc.projectRoot, messageId: 'm' });
  await openTools.stage(sc.target, 'owned dummy\n');
  await openTools.stage('control-after.txt', 'control\n');
  const late = (await open.get(b)).pending;
  if (!late) throw new Error('Expected a pending proposal staged without a policy');
  const stagedPath = late.files.map((f) => f.path).find((p) => p !== 'control-after.txt');
  expect(late.files, 'both proposals staged while unrestricted').toHaveLength(2);
  const restricted = createChangesService({ dataDir, sandbox });
  const lateApplied = await restricted
    .apply({ chatId: b, projectRoot: sc.projectRoot, revision: late.revision, decisions: acceptAll(late) })
    .then(
      ({ batch }) => ({ written: batch.written.map((f) => f.path), conflicts: batch.conflicts }),
      (e: unknown) => ({ error: (e as { code?: string }).code ?? String(e) }),
    );
  expect.soft(lateApplied, 'apply (policy after stage)').toEqual({
    written: ['control-after.txt'],
    conflicts: [{ path: stagedPath, reason: 'blocked' }],
  });
  expect(await readFile(path.join(realRoot, 'control-after.txt'), 'utf8'), 'late control applied').toBe('control\n');
  await nothingCreated('policy after stage');
  await linksIntact('policy after stage');

  // 3. The root already exists, created through the alias spelling (what the write would have made). No data-dir
  //    marker is present, so only the root policy can hide it; a sibling file is the visible control.
  await put(realRoot, sc.target, 'NEEDLE owned dummy\n');
  const deniedDirRel = path.posix.dirname(sc.target);
  const parentRel = path.posix.dirname(deniedDirRel);
  const visibleRel = path.posix.join(parentRel, 'visible.txt');
  await put(realRoot, visibleRel, 'NEEDLE visible control\n');
  expect(
    await sameInode(path.join(sc.denied, 'projects.json'), path.join(realRoot, sc.target)),
    'the seeded file is the file inside the denied root',
  ).toBe(true);
  expect(await exists(path.join(realRoot, deniedDirRel, 'chats', 'index.json')), 'no data-dir marker').toBe(false);
  const listPath = parentRel === '.' ? '.' : parentRel;
  const t = tools(sandbox);
  const open3 = tools();
  const toolCtx: ToolContext = { projectRoot: sc.projectRoot, signal: new AbortController().signal };
  const canonicalRel = toPosixRel(realRoot, path.join(sc.denied, 'projects.json'));

  // Controls first (non-vacuous): without the policy the seeded file is visible to the same callers.
  expect((await open3('read_file').run({ path: sc.target }, toolCtx)).output).toContain('owned dummy');
  expect((await open3('list_files').run({ path: listPath, depth: 5 }, toolCtx)).output).toContain('projects.json');
  expect(await renderTree(sc.projectRoot, { depth: 8, maxEntries: 1000 })).toContain('projects.json');

  for (const rel of [sc.target, ...(canonicalRel ? [canonicalRel] : [])]) {
    expect.soft(await t('read_file').run({ path: rel }, toolCtx), `read_file ${rel}`).toMatchObject({
      ok: false,
      output: BLOCKED_MESSAGE,
    });
  }
  const visible = await t('read_file').run({ path: visibleRel }, toolCtx);
  expect(visible.output, 'visible control read').toContain('visible control');
  const listing = await t('list_files').run({ path: listPath, depth: 5 }, toolCtx);
  expect(listing.ok).toBe(true);
  expect(listing.output, 'listing shows the control').toContain('visible.txt');
  expect.soft(listing.output, 'listing hides the denied root').not.toContain('projects.json');
  const found = await t('search').run({ query: 'NEEDLE', path: listPath }, toolCtx);
  expect(found.ok).toBe(true);
  expect(found.output, 'search finds the control').toContain('visible control');
  expect.soft(found.output, 'search hides the denied root').not.toContain('owned dummy');
  const tree = await renderTree(sc.projectRoot, { depth: 8, maxEntries: 1000, deniedRoots: sc.deniedRoots });
  expect(tree, 'tree shows the control').toContain('visible.txt');
  expect.soft(tree, 'tree hides the denied root').not.toContain('projects.json');
  await linksIntact('seeded root');
}

/** `abs` relative to `realRoot` in POSIX form, or null when it is not below it lexically (e.g. a `/tmp` spelling). */
function toPosixRel(realRoot: string, abs: string): string | null {
  const rel = path.relative(realRoot, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/');
}

describe('AS-06 review P1: Unicode full case-fold aliases of a missing denied root', () => {
  let foldAliases = false;
  const owned: string[] = [];
  beforeAll(async () => {
    const gate = path.join(root, 'fold-gate');
    await mkdir(gate);
    const results = await Promise.all(
      FOLD_FAMILIES.map(async ([plain, special]) => {
        await writeFile(path.join(gate, `cfg-${plain}`), 'probe');
        return sameInode(path.join(gate, `cfg-${plain}`), path.join(gate, `cfg-${special}`));
      }),
    );
    foldAliases = results.every(Boolean);
  });
  afterAll(async () => {
    await Promise.all(owned.map((d) => rm(d, { recursive: true, force: true })));
  });

  /** Skips where the volume doesn't alias full case folds, except on macOS (gate failure). */
  function requireFoldAliases(ctx: SkipCtx): void {
    if (foldAliases) return;
    if (isMac) throw new Error('macOS gate: the temp volume does not alias ſ/s, ß/ss, ς/σ, ﬀ/ff, so P1 cannot run');
    ctx.skip();
  }

  async function ownedBase(): Promise<string> {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'openvern-as06-p1-')));
    owned.push(base);
    return base;
  }

  it('measures the four review families as one name on this macOS volume', (ctx) => {
    if (!isMac) ctx.skip();
    expect(foldAliases).toBe(true);
  });

  it('review repro: `Library/Application ſupport/openvern` in a fake home without Application Support', async (ctx) => {
    requireFoldAliases(ctx);
    const base = await ownedBase();
    const home = path.join(base, 'home');
    await mkdir(home);
    const deniedRoots = await defaultDataDirRoots({}, home);
    await exerciseDeniedRoot({
      label: 'p1-review',
      projectRoot: home,
      deniedRoots,
      denied: path.join(home, 'Library', 'Application Support', 'openvern'),
      target: 'Library/Application ſupport/openvern/projects.json',
    });
  });

  for (const [plain, special] of FOLD_FAMILIES) {
    for (const [rootSpelling, targetSpelling, dir] of [
      [plain, special, 'fwd'],
      [special, plain, 'rev'],
    ] as const) {
      it(`missing parent segment: root cfg-${rootSpelling}, target cfg-${targetSpelling}`, async (ctx) => {
        requireFoldAliases(ctx);
        const base = await ownedBase();
        await mkdir(path.join(base, 'home'));
        const xdg = path.join(base, `cfg-${rootSpelling}`);
        const deniedRoots = await defaultDataDirRoots({ XDG_CONFIG_HOME: xdg }, path.join(base, 'home'));
        await exerciseDeniedRoot({
          label: `p1-missing-${FOLD_FAMILIES.findIndex((f) => f[0] === plain)}-${dir}`,
          projectRoot: base,
          deniedRoots,
          denied: path.join(xdg, 'openvern'),
          target: `cfg-${targetSpelling}/openvern/projects.json`,
        });
      });

      it(`existing parent alias: on disk cfg-${targetSpelling}, root spelled cfg-${rootSpelling}`, async (ctx) => {
        requireFoldAliases(ctx);
        const base = await ownedBase();
        await mkdir(path.join(base, 'home'));
        await mkdir(path.join(base, `cfg-${targetSpelling}`));
        const xdg = path.join(base, `cfg-${rootSpelling}`);
        expect(await sameInode(xdg, path.join(base, `cfg-${targetSpelling}`)), 'measured parent alias').toBe(true);
        const deniedRoots = await defaultDataDirRoots({ XDG_CONFIG_HOME: xdg }, path.join(base, 'home'));
        await exerciseDeniedRoot({
          label: `p1-existing-${FOLD_FAMILIES.findIndex((f) => f[0] === plain)}-${dir}`,
          projectRoot: base,
          deniedRoots,
          denied: path.join(xdg, 'openvern'),
          target: `cfg-${targetSpelling}/openvern/projects.json`,
        });
      });
    }
  }

  it('matches every APFS alias among case-mapped and compatibility code points and their images', async (ctx) => {
    requireFoldAliases(ctx);
    const dir = await ownedBase();
    const name = (s: string) => `a${s}b`;
    const candidates: string[] = [];
    for (let cp = 1; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      // Hangul syllables only decompose canonically (covered by the NFC/NFD tests); skipped to bound the run.
      if (cp >= 0xac00 && cp <= 0xd7a3) continue;
      const c = String.fromCodePoint(cp);
      if (c === '/' || /[\p{Cn}\p{Co}]/u.test(c)) continue;
      if (c.toUpperCase() !== c || c.toLowerCase() !== c || c.normalize('NFKD') !== c) candidates.push(c);
    }
    const inode = new Map<string, number>();
    // Created one at a time (an alias must find the first spelling already there); `a` opens an existing alias
    // instead of failing, so each code point lands in its volume class.
    for (const c of candidates) await (await open(path.join(dir, name(c)), 'a')).close();
    const statAll = async (names: string[]) => {
      const out: (number | null)[] = [];
      for (let i = 0; i < names.length; i += 256) {
        const chunk = names.slice(i, i + 256).map((n) =>
          stat(path.join(dir, n)).then(
            (s) => s.ino,
            () => null,
          ),
        );
        out.push(...(await Promise.all(chunk)));
      }
      return out;
    };
    const candidateInodes = await statAll(candidates.map(name));
    candidates.forEach((c, i) => {
      inode.set(c, candidateInodes[i] as number);
    });
    const misses: string[] = [];
    let pairs = 0;
    const hex = (s: string) => [...s].map((ch) => ch.codePointAt(0)?.toString(16)).join(' ');
    const check = (x: string, y: string) => {
      pairs++;
      for (const [r, tgt] of [
        [x, y],
        [y, x],
      ] as const) {
        if (!isWithinAny([path.join(dir, name(r), 'openvern')], path.join(dir, name(tgt), 'openvern', 'f'))) {
          misses.push(`${hex(r)} -> ${hex(tgt)}`);
        }
      }
    };
    const firstOfClass = new Map<number, string>();
    for (const c of candidates) {
      const ino = inode.get(c) as number;
      const first = firstOfClass.get(ino);
      if (first === undefined) firstOfClass.set(ino, c);
      else check(first, c);
    }
    let expansions = 0;
    const images: [string, string][] = [];
    for (const c of candidates) {
      const forms = [c.toLowerCase(), c.toUpperCase(), c.toUpperCase().toLowerCase(), c.normalize('NFD')];
      for (const x of new Set([...forms, c.normalize('NFKD')])) {
        if (x !== c && !x.includes('/')) images.push([c, x]);
      }
    }
    const imageInodes = await statAll(images.map(([, x]) => name(x)));
    images.forEach(([c, x], i) => {
      if (imageInodes[i] !== inode.get(c)) return;
      if ([...x].length > 1) expansions++;
      check(c, x);
    });
    expect(misses.slice(0, 20), `${misses.length} APFS aliases not matched`).toEqual([]);
    // Non-vacuous: the sweep found many aliases, multi-character expansions (ß -> ss, ﬀ -> ff) among them.
    expect(pairs).toBeGreaterThan(1000);
    expect(expansions).toBeGreaterThan(50);
  }, 60_000);
});

describe('AS-06 review P2: a lexical fallback root below a symlinked ancestor', () => {
  const owned: string[] = [];
  afterAll(async () => {
    await Promise.all(owned.map((d) => rm(d, { recursive: true, force: true })));
  });

  /** macOS only: on other platforms root canonicalization is not added (Linux matching stays exact, unchanged). */
  function requireMac(ctx: SkipCtx): void {
    if (!isMac) ctx.skip();
  }

  for (const xdgName of ['config', 'config-missing'] as const) {
    it(`real /tmp alias: XDG root /tmp/…/${xdgName}/openvern, project /private/tmp/…`, async (ctx) => {
      requireMac(ctx);
      const tmpLink = await lstat('/tmp').then(
        (s) => s.isSymbolicLink(),
        () => false,
      );
      if (!tmpLink || (await realpath('/tmp')) !== '/private/tmp') {
        throw new Error('macOS gate: /tmp is not a symlink to /private/tmp');
      }
      const lexicalBase = await mkdtemp('/tmp/openvern-as06-p2-');
      const base = await realpath(lexicalBase);
      owned.push(base);
      expect(base.startsWith('/private/tmp/')).toBe(true);
      await mkdir(path.join(base, 'home'));
      if (xdgName === 'config') await mkdir(path.join(base, 'config'));
      const xdg = path.join(lexicalBase, xdgName);
      // Only the function argument carries XDG_CONFIG_HOME; the process environment is untouched.
      const deniedRoots = await defaultDataDirRoots({ XDG_CONFIG_HOME: xdg }, path.join(base, 'home'));
      const denied = path.join(xdg, 'openvern');
      expect(denied.startsWith('/tmp/')).toBe(true);
      await exerciseDeniedRoot({
        label: `p2-tmp-${xdgName}`,
        projectRoot: base,
        deniedRoots,
        denied,
        target: `${xdgName}/openvern/projects.json`,
      });
    });
  }

  it('owned symlinked fake home: missing `Library/Application Support`', async (ctx) => {
    requireMac(ctx);
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'openvern-as06-p2-')));
    owned.push(base);
    const realHome = path.join(base, 'home-real');
    const homeLink = path.join(base, 'home-link');
    await mkdir(realHome);
    await symlink(realHome, homeLink);
    const deniedRoots = await defaultDataDirRoots({}, homeLink);
    await exerciseDeniedRoot({
      label: 'p2-home-missing',
      projectRoot: homeLink,
      deniedRoots,
      denied: path.join(homeLink, 'Library', 'Application Support', 'openvern'),
      target: 'Library/Application Support/openvern/projects.json',
    });
  });

  it('owned symlinked fake home: existing parent stored as a case alias (`.Config` for `.config`)', async (ctx) => {
    requireMac(ctx);
    requireInsensitive(ctx);
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'openvern-as06-p2-')));
    owned.push(base);
    const realHome = path.join(base, 'home-real');
    const homeLink = path.join(base, 'home-link');
    await mkdir(path.join(realHome, '.Config'), { recursive: true });
    await symlink(realHome, homeLink);
    const deniedRoots = await defaultDataDirRoots({}, homeLink);
    expect(await sameInode(path.join(homeLink, '.config'), path.join(realHome, '.Config'))).toBe(true);
    await exerciseDeniedRoot({
      label: 'p2-home-existing',
      projectRoot: realHome,
      deniedRoots,
      denied: path.join(homeLink, '.config', 'openvern'),
      target: '.Config/openvern/projects.json',
    });
  });
});

// ------------------------------------------------------------------------------------ re-review: dangling root link
// A production default root that is a dangling symlink when the policy is built (say, a symlink-managed profile whose
// destination doesn't exist yet). `defaultDataDirRoots` can't realpath it, so it keeps the lexical root (its AS-05
// contract). A write spelled through the destination must still be refused before any `mkdir`, at stage and at apply,
// and once the destination exists its contents stay hidden. The test creates every link and never changes one; every
// write goes through the real tools, a real ChangesService and a real apply. Content is dummy text.

describe('AS-06 re-review: a default data-dir root that is a dangling symlink', () => {
  const owned: string[] = [];
  afterAll(async () => {
    await Promise.all(owned.map((d) => rm(d, { recursive: true, force: true })));
  });

  /** macOS only: root resolution is darwin-only; Linux matching stays exact, with no filesystem lookups. */
  function requireMac(ctx: SkipCtx): void {
    if (!isMac) ctx.skip();
  }

  /** An owned fake home with `Library/` present. `Library/Application Support` and its `openvern` don't exist. */
  async function fakeHome() {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'openvern-as06-dangle-')));
    owned.push(base);
    const home = path.join(base, 'home');
    await mkdir(path.join(home, 'Library'), { recursive: true });
    const appSupport = path.join(home, 'Library', 'Application Support');
    return { home, appSupport, denied: path.join(appSupport, 'openvern') };
  }

  async function makeLinks(links: Record<string, string>): Promise<void> {
    for (const [link, dest] of Object.entries(links)) await symlink(dest, link);
  }

  const policy = (deniedRoots: string[]): SandboxOptions => ({
    deniedRoots,
    deniedFiles: deniedRoots.map((r) => path.join(r, 'secrets.json')),
  });

  async function applyAll(svc: ReturnType<typeof createChangesService>, chatId: string, projectRoot: string) {
    const pending = (await svc.get(chatId)).pending;
    if (!pending) throw new Error('Expected a pending proposal');
    const { batch } = await svc.apply({
      chatId,
      projectRoot,
      revision: pending.revision,
      decisions: acceptAll(pending),
    });
    return { written: batch.written.map((f) => f.path), conflicts: batch.conflicts };
  }

  for (const form of ['absolute', 'relative'] as const) {
    it(`pre-existing dangling root link, ${form} destination: refused at stage and apply, nothing created`, async (ctx) => {
      requireMac(ctx);
      const { home, appSupport, denied } = await fakeHome();
      await mkdir(appSupport);
      const profile = path.join(home, 'profiles', 'installed-profile');
      const dest = form === 'absolute' ? profile : path.join('..', '..', 'profiles', 'installed-profile');
      const links = { [denied]: dest };
      await makeLinks(links); // before the policy is built; never changed afterwards
      const deniedRoots = await defaultDataDirRoots({}, home);
      const target = 'profiles/installed-profile/projects.json';
      // Linux keeps exact matching: the destination spelling is not added there (unchanged, no lookups).
      expect(isWithinAny(deniedRoots, path.join(home, target), 'linux')).toBe(false);
      await exerciseDeniedRoot({ label: `dangle-${form}`, projectRoot: home, deniedRoots, denied, target, links });
    });
  }

  it('dangling intermediate component (`Application Support` -> a missing dir): refused below the root', async (ctx) => {
    requireMac(ctx);
    const { home, appSupport, denied } = await fakeHome();
    const links = { [appSupport]: path.join(home, 'profiles', 'app-support') };
    await makeLinks(links);
    const deniedRoots = await defaultDataDirRoots({}, home);
    await exerciseDeniedRoot({
      label: 'dangle-mid',
      projectRoot: home,
      deniedRoots,
      denied,
      target: 'profiles/app-support/openvern/projects.json',
      links,
    });
  });

  it('dangling intermediate component: the missing root suffix is kept, so a sibling stays writable', async (ctx) => {
    requireMac(ctx);
    const { home, appSupport, denied } = await fakeHome();
    const dest = path.join(home, 'profiles', 'app-support');
    await makeLinks({ [appSupport]: dest });
    const deniedRoots = await defaultDataDirRoots({}, home);
    expect(deniedRoots).toContain(denied);
    const sandbox = policy(deniedRoots);
    const write = tools(sandbox)('write_file');
    const { svc, ctx: toolCtx } = await realContext(home, 'dangle-mid-sibling', sandbox);
    const forbidden = ['profiles/app-support/openvern/projects.json', 'profiles/app-support/harness/settings.json'];
    for (const rel of forbidden) {
      expect.soft(await write.run({ path: rel, content: 'owned dummy\n' }, toolCtx), rel).toMatchObject({
        ok: false,
        output: BLOCKED_MESSAGE,
      });
    }
    const allowed = await write.run({ path: 'profiles/app-support/allowed.txt', content: 'control\n' }, toolCtx);
    expect(allowed, 'sibling control').toMatchObject({ ok: true });
    expect(await applyAll(svc, 'dangle-mid-sibling', home)).toEqual({
      written: ['profiles/app-support/allowed.txt'],
      conflicts: [],
    });
    // The control made the link live; the root below it is still missing and still refused.
    expect(await readFile(path.join(appSupport, 'allowed.txt'), 'utf8')).toBe('control\n');
    for (const rel of forbidden) {
      expect.soft(await write.run({ path: rel, content: 'owned dummy\n' }, toolCtx), `${rel} (live)`).toMatchObject({
        ok: false,
        output: BLOCKED_MESSAGE,
      });
      expect(await exists(path.join(home, path.dirname(rel))), `${rel}: never created`).toBe(false);
    }
    expect(await readlink(appSupport)).toBe(dest);
  });

  it('follows a static chain of relative and absolute links, `..` applied after a live link', async (ctx) => {
    requireMac(ctx);
    const { home, appSupport, denied } = await fakeHome();
    await mkdir(appSupport);
    const hops = path.join(home, 'links');
    await mkdir(hops);
    await mkdir(path.join(home, 'profiles', 'x'), { recursive: true });
    const links = {
      [denied]: 'hop-1', // relative, same directory
      [path.join(appSupport, 'hop-1')]: path.join(hops, 'hop-2'), // absolute
      // Relative. The kernel resolves `elsewhere` (-> profiles/x) before `..`, giving profiles/deep/installed; a
      // lexical join would give links/deep/installed instead.
      [path.join(hops, 'hop-2')]: 'elsewhere/../deep/installed',
      [path.join(hops, 'elsewhere')]: path.join(home, 'profiles', 'x'), // live
    };
    await makeLinks(links);
    const deniedRoots = await defaultDataDirRoots({}, home);
    await exerciseDeniedRoot({
      label: 'dangle-chain',
      projectRoot: home,
      deniedRoots,
      denied,
      target: 'profiles/deep/installed/projects.json',
      links,
    });
  });

  it('follows a 32-link chain (the most one lookup traverses on this Mac) to the missing destination', async (ctx) => {
    requireMac(ctx);
    const { home, appSupport, denied } = await fakeHome();
    await mkdir(appSupport);
    const chain = path.join(home, 'chain');
    await mkdir(chain);
    // `openvern` -> l30 -> … -> l0 -> profiles/end: 32 links. Step 3 of the scenario reads through all of them.
    const links: Record<string, string> = { [denied]: path.join(chain, 'l30') };
    links[path.join(chain, 'l0')] = path.join(home, 'profiles', 'end');
    for (let i = 1; i <= 30; i++) links[path.join(chain, `l${i}`)] = `l${i - 1}`;
    await makeLinks(links);
    const deniedRoots = await defaultDataDirRoots({}, home);
    await exerciseDeniedRoot({
      label: 'dangle-chain-32',
      projectRoot: home,
      deniedRoots,
      denied,
      target: 'profiles/end/projects.json',
      links,
    });
  });

  it('stays bounded on link loops and on chains no lookup can follow; lexical denial kept, controls apply', async (ctx) => {
    requireMac(ctx);
    for (const shape of ['self', 'pair', 'long'] as const) {
      const { home, appSupport, denied } = await fakeHome();
      await mkdir(appSupport);
      const links: Record<string, string> = {};
      if (shape === 'self') links[denied] = 'openvern';
      if (shape === 'pair') {
        links[denied] = 'loop-b';
        links[path.join(appSupport, 'loop-b')] = 'openvern';
      }
      if (shape === 'long') {
        // 45 links, ending in a missing directory: more than the kernel (32) or the resolver (40) follows.
        links[denied] = 'c43';
        for (let i = 1; i <= 43; i++) links[path.join(appSupport, `c${i}`)] = `c${i - 1}`;
        links[path.join(appSupport, 'c0')] = path.join(home, 'profiles', 'end');
      }
      await makeLinks(links);
      const deniedRoots = await defaultDataDirRoots({}, home);
      expect(deniedRoots, shape).toContain(denied);
      // Nothing can be reached, or planted, through the root: every lookup through it fails.
      await expect(stat(path.join(denied, 'projects.json')), shape).rejects.toMatchObject({ code: 'ELOOP' });
      for (const t of [
        path.join(denied, 'projects.json'),
        path.join(home, 'profiles', 'end', 'projects.json'),
        path.join(home, 'notes', 'x'),
      ]) {
        expect(() => isWithinAny(deniedRoots, t), `${shape}: ${t}`).not.toThrow();
      }
      expect(isWithinAny(deniedRoots, path.join(denied, 'projects.json')), shape).toBe(true);
      expect(isWithinAny(deniedRoots, path.join(home, 'notes', 'x')), shape).toBe(false);
      const sandbox = policy(deniedRoots);
      const write = tools(sandbox)('write_file');
      const { svc, ctx: toolCtx } = await realContext(home, `dangle-loop-${shape}`, sandbox);
      const viaRoot = await write.run(
        { path: 'Library/Application Support/openvern/projects.json', content: 'x' },
        toolCtx,
      );
      expect(viaRoot, shape).toMatchObject({ ok: false, output: BLOCKED_MESSAGE });
      expect(await write.run({ path: 'notes/control.txt', content: 'control\n' }, toolCtx), shape).toMatchObject({
        ok: true,
      });
      expect(await applyAll(svc, `dangle-loop-${shape}`, home), shape).toEqual({
        written: ['notes/control.txt'],
        conflicts: [],
      });
      expect(await readFile(path.join(home, 'notes', 'control.txt'), 'utf8')).toBe('control\n');
      for (const [link, dest] of Object.entries(links)) expect(await readlink(link), `${shape}: ${link}`).toBe(dest);
    }
  });

  it('control: a root link whose destination exists before the policy is built is denied canonically', async (ctx) => {
    requireMac(ctx);
    const { home, appSupport, denied } = await fakeHome();
    await mkdir(appSupport);
    const profile = path.join(home, 'profiles', 'installed-profile');
    await mkdir(profile, { recursive: true });
    await symlink(profile, denied);
    const deniedRoots = await defaultDataDirRoots({}, home);
    expect(deniedRoots, 'the supplier returns the realpath').toContain(profile);
    const sandbox = policy(deniedRoots);
    const { svc, ctx: toolCtx } = await realContext(home, 'dangle-existing', sandbox);
    const write = tools(sandbox)('write_file');
    const proposed = await write.run({ path: 'profiles/installed-profile/projects.json', content: 'x' }, toolCtx);
    expect(proposed).toMatchObject({ ok: false, output: BLOCKED_MESSAGE });
    expect(await write.run({ path: 'control.txt', content: 'control\n' }, toolCtx)).toMatchObject({ ok: true });
    expect(await applyAll(svc, 'dangle-existing', home)).toEqual({ written: ['control.txt'], conflicts: [] });
    expect(await exists(path.join(profile, 'projects.json'))).toBe(false);
    expect(await readlink(denied)).toBe(profile);
  });

  it('policy lifetime: a dangling root link created after the policy was built, before staging', async (ctx) => {
    requireMac(ctx);
    const { home, appSupport, denied } = await fakeHome();
    await mkdir(appSupport);
    const deniedRoots = await defaultDataDirRoots({}, home); // `openvern` is absent: kept lexically
    const links = { [denied]: path.join(home, 'profiles', 'installed-profile') };
    await makeLinks(links); // completed before staging; nothing changes while a check runs
    await exerciseDeniedRoot({
      label: 'dangle-after-policy',
      projectRoot: home,
      deniedRoots,
      denied,
      target: 'profiles/installed-profile/projects.json',
      links,
    });
  });

  it('policy lifetime: a root link to an existing folder, created after the policy was built, hides it', async (ctx) => {
    requireMac(ctx);
    const { home, appSupport, denied } = await fakeHome();
    await mkdir(appSupport);
    const deniedRoots = await defaultDataDirRoots({}, home);
    expect(deniedRoots).toContain(denied);
    const profile = path.join(home, 'profiles', 'installed-profile');
    await put(profile, 'projects.json', 'NEEDLE owned dummy\n');
    await put(home, 'profiles/visible.txt', 'NEEDLE visible control\n');
    await symlink(profile, denied); // completed before any tool call
    expect(await exists(path.join(profile, 'chats', 'index.json')), 'no data-dir marker').toBe(false);
    const toolCtx: ToolContext = { projectRoot: home, signal: new AbortController().signal };
    const open = tools();
    expect(
      (await open('read_file').run({ path: 'profiles/installed-profile/projects.json' }, toolCtx)).output,
    ).toContain('owned dummy');
    expect((await open('list_files').run({ path: 'profiles', depth: 5 }, toolCtx)).output).toContain('projects.json');

    const sandbox = policy(deniedRoots);
    const t = tools(sandbox);
    for (const rel of [
      'profiles/installed-profile/projects.json',
      'Library/Application Support/openvern/projects.json',
    ]) {
      expect.soft(await t('read_file').run({ path: rel }, toolCtx), rel).toMatchObject({
        ok: false,
        output: BLOCKED_MESSAGE,
      });
    }
    const listing = await t('list_files').run({ path: 'profiles', depth: 5 }, toolCtx);
    expect(listing.output).toContain('visible.txt');
    expect.soft(listing.output, 'listing hides the root').not.toContain('projects.json');
    const found = await t('search').run({ query: 'NEEDLE', path: 'profiles' }, toolCtx);
    expect(found.output).toContain('visible control');
    expect.soft(found.output, 'search hides the root').not.toContain('owned dummy');
    const tree = await renderTree(home, { depth: 8, maxEntries: 1000, deniedRoots });
    expect(tree).toContain('visible.txt');
    expect.soft(tree, 'tree hides the root').not.toContain('projects.json');

    const { svc, ctx: writeCtx } = await realContext(home, 'dangle-live-after-policy', sandbox);
    const proposed = await t('write_file').run({ path: 'profiles/installed-profile/new.json', content: 'x' }, writeCtx);
    expect.soft(proposed, 'write into the live root').toMatchObject({ ok: false, output: BLOCKED_MESSAGE });
    await t('write_file').run({ path: 'control.txt', content: 'control\n' }, writeCtx);
    expect.soft(await applyAll(svc, 'dangle-live-after-policy', home)).toEqual({
      written: ['control.txt'],
      conflicts: [],
    });
    expect(await exists(path.join(profile, 'new.json'))).toBe(false);
    expect(await readlink(denied)).toBe(profile);
  });
});

describe('deniedRoots folding (pure, by platform): full case folding and documented over-denial', () => {
  const base = '/nonexistent-openvern-as06';
  const pairs = [...FOLD_FAMILIES, ['ss', 'ẞ'], ['k', 'K'], ['fi', 'ﬁ'], ['ΣΑΣ', 'σας']] as const;

  it('matches full case-fold aliases in both directions on darwin; Linux stays exact', () => {
    for (const [a, b] of pairs) {
      for (const [r, t] of [
        [a, b],
        [b, a],
      ]) {
        const rootPath = `${base}/cfg-${r}/openvern`;
        const target = `${base}/cfg-${t}/openvern/projects.json`;
        expect(isWithinAny([rootPath], target, 'darwin'), `darwin ${r} -> ${t}`).toBe(true);
        expect(isWithinAny([rootPath], target, 'linux'), `linux ${r} -> ${t}`).toBe(false);
      }
    }
  });

  it('over-denies compatibility and accent variants on darwin (fail-safe tradeoff, path-only)', () => {
    // Not APFS aliases: the darwin fold also drops combining marks and applies compatibility decomposition, so
    // these distinct folders are denied too. Exact on Linux.
    const rootPath = `${base}/openvern`;
    for (const t of ['öpenvern', 'ｏｐｅｎｖｅｒｎ', 'openverń', 'opeⁿvern']) {
      expect(isWithinAny([rootPath], `${base}/${t}/x`, 'darwin'), t).toBe(true);
      expect(isWithinAny([rootPath], `${base}/${t}/x`, 'linux'), t).toBe(false);
    }
  });

  it('stays segment-wise: folding never creates separators or parent steps', () => {
    const rootPath = `${base}/app/openvern`;
    // `‥` (U+2025) and `／` (U+FF0F) decompose to `..` and `/`; they are compared as one segment, never resolved.
    expect(isWithinAny([rootPath], `${base}/app/openvern/‥/‥/x`, 'darwin')).toBe(true);
    expect(isWithinAny([rootPath], `${base}/app/x/‥/openvern`, 'darwin')).toBe(false);
    expect(isWithinAny([rootPath], `${base}/app／openvern/x`, 'darwin')).toBe(false);
    expect(isWithinAny([rootPath], `${base}/app/openvern-other/x`, 'darwin')).toBe(false);
    expect(isWithinAny([rootPath], `${base}/app`, 'darwin')).toBe(false);
    expect(isWithinAny(['/'], `${base}/x`, 'darwin')).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ AS-06 R4 (P1–P3)
// P1: the firmlink spellings `/System/Volumes/Data/<source>/…` and `/<source>/…` of a denied root and of the project.
// P2: Unicode aliases of denied names that APFS stores as one name (`secretſ.json` is `secrets.json`).
// P3: the respelling diagnostic for those aliases. Fixtures are owned `mkdtemp` bases under `os.tmpdir()`, spelled as
// their realpath (`/private/var/folders/…`, "short") and below the data volume ("long"), with dummy content and no
// `chats/index.json` anywhere, so the data-dir content fallback can't mask a root check. Env reaches
// `defaultDataDirRoots` as an argument only. On macOS every case runs; a failed precondition fails it, never skips it.

const DATA_VOLUME = '/System/Volumes/Data';
const HIDDEN_TEXT = 'NEEDLE owned dummy\n';
const VISIBLE_TEXT = 'NEEDLE visible control\n';

const r4Owned: string[] = [];
afterAll(async () => {
  await Promise.all(r4Owned.map((d) => rm(d, { recursive: true, force: true })));
});

/** Skips off macOS. On macOS a missing data volume fails the case (it can't hold the long spelling). */
async function requireDataVolume(ctx: SkipCtx): Promise<void> {
  if (!isMac) {
    ctx.skip();
    return;
  }
  if (!(await exists(DATA_VOLUME))) throw new Error(`macOS gate: ${DATA_VOLUME} is missing, so AS-06 R4 cannot run`);
}

/** An owned base in its realpath ("short") spelling and its firmlink ("long") spelling. */
async function r4Base(): Promise<{ base: string; long: string }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'ov-as06-r4-')));
  r4Owned.push(base);
  return { base, long: `${DATA_VOLUME}${base}` };
}

/** The sandbox shape production builds from its roots (`core/index.ts`): roots plus each root's `secrets.json`. */
const r4Policy = (deniedRoots: readonly string[]): SandboxOptions => ({
  deniedRoots: [...deniedRoots],
  deniedFiles: deniedRoots.map((r) => path.join(r, 'secrets.json')),
});

/** A real Files service for one project registered at `rootPath` (as spelled), with the given policy. */
function filesFor(rootPath: string, sandbox: SandboxOptions) {
  return createProjectFilesService({
    projects: { get: async () => ({ id: 'p', name: 'p', rootPath, createdAt: '' }) },
    deniedRoots: sandbox.deniedRoots,
    deniedFiles: sandbox.deniedFiles,
  });
}

/** Every path the real walker yields for the project, from its realpath as every caller passes it. */
async function walkRels(projectRoot: string, deniedRoots?: readonly string[]): Promise<string[]> {
  const rels: string[] = [];
  const signal = new AbortController().signal;
  for await (const e of walk({ root: await realpath(projectRoot), startRel: '', maxDepth: 20, signal, deniedRoots })) {
    rels.push(e.rel);
  }
  return rels;
}

const hasSegment = (rel: string, names: readonly string[]) => rel.split('/').some((s) => names.includes(s));

interface Exposure {
  projectRoot: string;
  sandbox: SandboxOptions;
  /** Project-relative directory that holds both the protected entry and the control (scoped search and listing). */
  dir: string;
  /** Spellings of the protected file the model may ask for; each must be refused. */
  hidden: string[];
  /** Segment names (the protected file and, for a root, its directory) that no listing may show. */
  hiddenNames: string[];
  /** Project-relative path of the allowed control (content `VISIBLE_TEXT`). */
  visible: string;
  /** Root policy cases: first prove that the same callers show the protected file without the policy. */
  openControls: boolean;
}

/**
 * The visibility matrix for one protected file: `read_file`, scoped and whole-project `search` and `list_files`,
 * `renderTree`, the walker, and Files `tree` / `read`. Each refusal is soft, so one run reports every leaking caller;
 * each control is hard.
 */
async function expectHiddenEverywhere(x: Exposure): Promise<void> {
  const ctx: ToolContext = { projectRoot: x.projectRoot, signal: new AbortController().signal };
  const visibleName = path.posix.basename(x.visible);
  const files = filesFor(x.projectRoot, x.sandbox);
  const [hiddenPath] = x.hidden;
  if (hiddenPath === undefined) throw new Error('expected a protected path');

  if (x.openControls) {
    const open = tools();
    const files0 = filesFor(x.projectRoot, {});
    expect((await open('read_file').run({ path: hiddenPath }, ctx)).output, 'open read_file').toContain('owned dummy');
    expect((await open('search').run({ query: 'NEEDLE' }, ctx)).output, 'open search').toContain('owned dummy');
    expect((await open('list_files').run({ depth: 5 }, ctx)).output, 'open list_files').toContain('projects.json');
    expect(await renderTree(x.projectRoot, { depth: 8, maxEntries: 1000 }), 'open tree').toContain('projects.json');
    expect(
      (await walkRels(x.projectRoot)).filter((r) => hasSegment(r, x.hiddenNames)),
      'open walk',
    ).not.toEqual([]);
    expect(
      (await files0.tree('p')).entries.filter((e) => hasSegment(e.path, x.hiddenNames)),
      'open Files tree',
    ).not.toEqual([]);
    expect((await files0.read('p', hiddenPath)).content, 'open Files read').toContain('owned dummy');
  }

  const t = tools(x.sandbox);
  const visible = await t('read_file').run({ path: x.visible }, ctx);
  expect(visible.output, 'read_file control').toContain('visible control');
  for (const rel of x.hidden) {
    expect.soft(await t('read_file').run({ path: rel }, ctx), `read_file ${rel}`).toMatchObject({
      ok: false,
      output: BLOCKED_MESSAGE,
    });
  }

  for (const [label, args] of [
    ['scoped search', { query: 'NEEDLE', path: x.dir }],
    ['whole-project search', { query: 'NEEDLE' }],
  ] as const) {
    const found = await t('search').run(args, ctx);
    expect(found.ok, label).toBe(true);
    expect(found.output, `${label} finds the control`).toContain('visible control');
    expect.soft(found.output, `${label} hides the protected file`).not.toContain('owned dummy');
  }

  for (const [label, args] of [
    ['scoped list_files', { path: x.dir, depth: 5 }],
    ['whole-project list_files', { depth: 5 }],
  ] as const) {
    const listing = await t('list_files').run(args, ctx);
    expect(listing.ok, label).toBe(true);
    expect(listing.output, `${label} shows the control`).toContain(visibleName);
    const lines = listing.output.split('\n').map((l) => l.trim().replace(/[/@]$/, ''));
    expect
      .soft(
        lines.filter((l) => x.hiddenNames.includes(l)),
        `${label} hides the protected entries`,
      )
      .toEqual([]);
  }

  const tree = await renderTree(x.projectRoot, { depth: 8, maxEntries: 1000, deniedRoots: x.sandbox.deniedRoots });
  expect(tree, 'renderTree shows the control').toContain(visibleName);
  const treeLines = tree.split('\n').map((l) => l.trim().replace(/[/@]$/, ''));
  expect
    .soft(
      treeLines.filter((l) => x.hiddenNames.includes(l)),
      'renderTree hides the protected entries',
    )
    .toEqual([]);

  const rels = await walkRels(x.projectRoot, x.sandbox.deniedRoots);
  expect(rels, 'walk yields the control').toContain(x.visible);
  expect
    .soft(
      rels.filter((r) => hasSegment(r, x.hiddenNames)),
      'walk hides the protected entries',
    )
    .toEqual([]);

  const listed = (await files.tree('p')).entries.map((e) => e.path);
  expect(listed, 'Files tree lists the control').toContain(x.visible);
  expect
    .soft(
      listed.filter((r) => hasSegment(r, x.hiddenNames)),
      'Files tree hides the protected entries',
    )
    .toEqual([]);
  expect((await files.read('p', x.visible)).content, 'Files read control').toContain('visible control');
  for (const rel of x.hidden) {
    await expect.soft(files.read('p', rel), `Files read ${rel}`).rejects.toMatchObject({ code: 'invalid_request' });
  }
}

/** Stage a control, apply everything pending, and return what the batch wrote. */
async function applyPending(svc: ReturnType<typeof createChangesService>, chatId: string, projectRoot: string) {
  const pending = (await svc.get(chatId)).pending;
  if (!pending) throw new Error('Expected a pending proposal (control)');
  const paths = pending.files.map((f) => f.path);
  const { batch } = await svc.apply({ chatId, projectRoot, revision: pending.revision, decisions: acceptAll(pending) });
  return { pending: paths, written: batch.written.map((f) => f.path), conflicts: batch.conflicts };
}

// ------------------------------------------------------------------------------------- R4 P1: pure (all OSes)

describe('AS-06 R4 P1 firmlink spellings (pure, by platform)', () => {
  // Unique names that can't exist on this Mac; the darwin branch may stat them, never create them.
  const p = 'openvern-r4-nonexistent-probe';
  const equated = [
    [
      'deep firmlink /System/Library/Caches',
      `/System/Library/Caches/${p}`,
      `${DATA_VOLUME}/System/Library/Caches/${p}`,
    ],
    ['/Users', `/Users/${p}`, `${DATA_VOLUME}/Users/${p}`],
    ['/usr/local', `/usr/local/${p}`, `${DATA_VOLUME}/usr/local/${p}`],
    ['case-variant prefix /system/volumes/data/users', `/Users/${p}`, `/system/volumes/data/users/${p}`],
    ['upper-case prefix /SYSTEM/VOLUMES/DATA/Users', `/Users/${p}`, `/SYSTEM/VOLUMES/DATA/Users/${p}`],
  ] as const;

  for (const [label, short, long] of equated) {
    it(`A6-P1-6 equates ${label}: long root denies the short target, and the short root the long target`, () => {
      expect.soft(isWithinAny([long], `${short}/f`, 'darwin'), 'root long, target short').toBe(true);
      expect.soft(isWithinAny([short], `${long}/f`, 'darwin'), 'root short, target long').toBe(true);
      expect.soft(isWithinAny([long], short, 'darwin'), 'root long, target = the root short').toBe(true);
      expect.soft(isWithinAny([short], long, 'darwin'), 'root short, target = the root long').toBe(true);
    });
  }

  it('A6-P1-6 control: injected linux equates no firmlink spelling', () => {
    for (const [label, short, long] of equated) {
      expect.soft(isWithinAny([long], `${short}/f`, 'linux'), `${label} long -> short`).toBe(false);
      expect.soft(isWithinAny([short], `${long}/f`, 'linux'), `${label} short -> long`).toBe(false);
    }
  });

  it('A6-P1-6 control: segment bounds, non-firmlinked Data paths and other volumes are never equated', () => {
    const notEquated = [
      [`/Users/${p}`, `/System/Volumes/DataX/Users/${p}`],
      [`/Users/${p}`, `${DATA_VOLUME}/Users2/${p}`],
      [`/usr/local/${p}`, `${DATA_VOLUME}/usr/localx/${p}`],
      ['/usr/local', `${DATA_VOLUME}/usr/localx`],
      [`/sw/${p}`, `${DATA_VOLUME}/sw/${p}`],
      // Not `/home`: it is a real symlink into the data volume, so `canonicalRoot` already equates it (correct).
      [`/usr/share/${p}`, `${DATA_VOLUME}/usr/share/${p}`],
      [`/System/Library/Caches/${p}`, `${DATA_VOLUME}/System/Library/CachesX/${p}`],
      [`/Users/${p}`, `/System/Volumes/Preboot/Users/${p}`],
      [`/Users/${p}/openvern`, `${DATA_VOLUME}/Users/${p}/openvern-other`],
    ] as const;
    for (const [a, b] of notEquated) {
      expect.soft(isWithinAny([a], `${b}/f`, 'darwin'), `root ${a}, target ${b}/f`).toBe(false);
      expect.soft(isWithinAny([b], `${a}/f`, 'darwin'), `root ${b}, target ${a}/f`).toBe(false);
    }
    // A short root never denies its own data-volume parent, and vice versa.
    expect.soft(isWithinAny([`/Users/${p}`], `${DATA_VOLUME}/Users`, 'darwin')).toBe(false);
    expect.soft(isWithinAny([`${DATA_VOLUME}/Users/${p}`], '/Users', 'darwin')).toBe(false);
  });
});

// ------------------------------------------------------------------------- R4 P1: filesystem (darwin, owned)

describe('AS-06 R4 P1 firmlink spellings of denied roots and projects (filesystem)', () => {
  it('A6-P1-8 precondition: both fixture spellings exist, keep their spelling and are one directory', async (ctx) => {
    await requireDataVolume(ctx);
    const { base, long } = await r4Base();
    expect(base.startsWith('/private/'), 'the realpath of the temp base is the short /private spelling').toBe(true);
    expect(await realpath(base)).toBe(base);
    expect(await realpath(long), 'realpath keeps the long spelling (the root cause of P1)').toBe(long);
    expect(await sameInode(base, long), 'same dev/ino').toBe(true);
  });

  it('A6-P1-7 drift guard: every /usr/share/firmlinks source is equated in both directions', async (ctx) => {
    await requireDataVolume(ctx);
    // Fails (ENOENT/EACCES) rather than skips when the file can't be read on macOS.
    const text = await readFile('/usr/share/firmlinks', 'utf8');
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length, 'the firmlink table is not empty').toBeGreaterThan(0);
    for (const line of lines) {
      const [source, target, ...rest] = line.split('\t');
      expect(rest, `${line}: two tab-separated fields`).toEqual([]);
      if (source === undefined || target === undefined) throw new Error(`unparsable firmlinks line: ${line}`);
      expect(source.startsWith('/'), `${line}: absolute source`).toBe(true);
      // The short form assumes each source maps to the same path below the data volume.
      expect(target, `${line}: target is the source below ${DATA_VOLUME}`).toBe(source.slice(1));
      const short = `${source}/openvern-r4-nonexistent-probe`;
      const long = `${DATA_VOLUME}${short}`;
      expect.soft(isWithinAny([short], `${long}/f`, 'darwin'), `${source}: short root, long target`).toBe(true);
      expect.soft(isWithinAny([long], `${short}/f`, 'darwin'), `${source}: long root, short target`).toBe(true);
    }
  });

  /** Seeds `config/openvern/projects.json` (protected) and `config/visible.txt` (control) below the short base. */
  async function seedConfig(base: string): Promise<void> {
    await put(base, 'config/openvern/projects.json', HIDDEN_TEXT);
    await put(base, 'config/visible.txt', VISIBLE_TEXT);
    expect(await exists(path.join(base, 'config/openvern/chats/index.json')), 'no data-dir marker').toBe(false);
  }

  const configExposure = (projectRoot: string, deniedRoots: string[]): Exposure => ({
    projectRoot,
    sandbox: r4Policy(deniedRoots),
    dir: 'config',
    hidden: ['config/openvern/projects.json'],
    hiddenNames: ['openvern', 'projects.json'],
    visible: 'config/visible.txt',
    openControls: true,
  });

  // A6-P1-1 (TG14) and the existing-root legs of A6-P1-3: the root exists before the supplier runs.
  const existing = [
    ['A6-P1-1', 'long', 'supplier', 'short'],
    ['A6-P1-3', 'short', 'direct', 'long'],
    ['A6-P1-3', 'short', 'supplier', 'long'],
  ] as const;
  for (const [id, project, source, rootSpelling] of existing) {
    it(`${id} existing marker-free root: project ${project}, root ${rootSpelling} (${source}), blocked everywhere`, async (ctx) => {
      await requireDataVolume(ctx);
      const { base, long } = await r4Base();
      const at = (s: 'short' | 'long') => (s === 'short' ? base : long);
      await seedConfig(base);
      const denied = `${at(rootSpelling)}/config/openvern`;
      const deniedRoots =
        source === 'direct'
          ? [denied]
          : await defaultDataDirRoots({ XDG_CONFIG_HOME: `${at(rootSpelling)}/config` }, `${base}/home`, 'darwin');
      expect(deniedRoots, 'the root is listed in the attacked spelling (supplier realpath branch)').toContain(denied);
      await expectHiddenEverywhere(configExposure(at(project), deniedRoots));
    });
  }

  // A6-P1-2 and the missing-root legs of A6-P1-3, through the shared harness (stage, apply with the policy at stage
  // and at apply only, then the seeded root), then the callers the harness doesn't drive. The harness checks
  // "nothing created" in both spellings: the missing directory below the project's spelling and the denied root.
  const missing = [
    ['A6-P1-2', 'long', 'supplier', 'short'],
    ['A6-P1-3', 'short', 'direct', 'long'],
    ['A6-P1-3', 'short', 'supplier', 'long'],
  ] as const;
  for (const [id, project, source, rootSpelling] of missing) {
    it(`${id} missing root: project ${project}, root ${rootSpelling} (${source}), refused at stage and apply`, async (ctx) => {
      await requireDataVolume(ctx);
      const { base, long } = await r4Base();
      const at = (s: 'short' | 'long') => (s === 'short' ? base : long);
      const denied = `${at(rootSpelling)}/config/openvern`;
      const deniedRoots =
        source === 'direct'
          ? [denied]
          : await defaultDataDirRoots({ XDG_CONFIG_HOME: `${at(rootSpelling)}/config` }, `${base}/home`, 'darwin');
      expect(deniedRoots, 'the supplier keeps the missing root lexically, in the attacked spelling').toContain(denied);
      const projectRoot = at(project);
      await exerciseDeniedRoot({
        label: `r4-p1-missing-${project}-${source}`,
        projectRoot,
        deniedRoots,
        denied,
        target: 'config/openvern/projects.json',
      });
      expect(await exists(path.join(base, 'config/openvern/chats/index.json')), 'no data-dir marker').toBe(false);
      await expectHiddenEverywhere(configExposure(projectRoot, deniedRoots));
    });
  }

  // TG10: only the short form of `canonicalRoot` can catch these (a dangling production root link whose destination
  // is spelled the other way from the project).
  const canonical = [
    ['short project, link destination long', 'short', 'long'],
    ['long project, link destination short', 'long', 'short'],
  ] as const;
  for (const [label, project, destination] of canonical) {
    it(`A6-P1-3 (TG10) dangling root link, ${label}: refused, and the created root stays hidden`, async (ctx) => {
      await requireDataVolume(ctx);
      const { base, long } = await r4Base();
      const at = (s: 'short' | 'long') => (s === 'short' ? base : long);
      const home = `${at(project)}/home`;
      await mkdir(path.join(base, 'home', 'Library', 'Application Support'), { recursive: true });
      const denied = path.join(home, 'Library', 'Application Support', 'openvern');
      const dest = `${at(destination)}/home/profiles/installed`;
      const links = { [denied]: dest };
      await makeR4Links(links); // before the policy is built; never changed afterwards
      const deniedRoots = await defaultDataDirRoots({}, home, 'darwin');
      expect(deniedRoots, 'the dangling root link is listed lexically').toContain(denied);
      const target = 'profiles/installed/projects.json';
      await exerciseDeniedRoot({ label: `r4-tg10-${project}`, projectRoot: home, deniedRoots, denied, target, links });
      await expectHiddenEverywhere({
        projectRoot: home,
        sandbox: r4Policy(deniedRoots),
        dir: 'profiles',
        hidden: [target],
        hiddenNames: ['installed', 'projects.json'],
        visible: 'profiles/visible.txt',
        openControls: true,
      });
    });
  }

  async function makeR4Links(links: Record<string, string>): Promise<void> {
    for (const [l, dest] of Object.entries(links)) await symlink(dest, l);
  }

  /** Every tool, `renderTree`, the walker and Files refuse a project whose root lies in a denied root. */
  async function expectProjectBlocked(label: string, projectRoot: string, deniedRoots: string[], fileRel: string) {
    const sandbox = r4Policy(deniedRoots);
    const plain: ToolContext = { projectRoot, signal: new AbortController().signal };
    // Non-vacuous: without the policy the project and its file are readable.
    expect((await tools()('read_file').run({ path: fileRel }, plain)).output, 'open read_file').toContain(
      'owned dummy',
    );
    expect(await renderTree(projectRoot, { depth: 8, maxEntries: 1000 }), 'open tree').toContain('notes.txt');

    const { svc, changes, ctx } = await realContext(projectRoot, label, sandbox);
    const t = tools(sandbox);
    const refused = { ok: false, output: BLOCKED_MESSAGE };
    expect.soft(await t('read_file').run({ path: fileRel }, ctx), 'read_file').toMatchObject(refused);
    expect.soft(await t('list_files').run({}, ctx), 'list_files').toMatchObject(refused);
    expect.soft(await t('search').run({ query: 'NEEDLE' }, ctx), 'search').toMatchObject(refused);
    expect
      .soft(await t('write_file').run({ path: 'new.txt', content: 'owned dummy\n' }, ctx), 'write_file')
      .toMatchObject(refused);
    expect.soft(await outcome(changes.stage('new2.txt', 'owned dummy\n')), 'ChangesService.stage').toBe('path_invalid');
    expect.soft((await svc.get(label)).pending?.files ?? [], 'nothing pending').toEqual([]);
    expect
      .soft(await renderTree(projectRoot, { depth: 8, maxEntries: 1000, deniedRoots }), 'renderTree')
      .toBe('(empty)');
    expect.soft(await walkRels(projectRoot, deniedRoots), 'walk').toEqual([]);
    const files = filesFor(projectRoot, sandbox);
    expect.soft((await files.tree('p')).entries, 'Files tree').toEqual([]);
    await expect.soft(files.read('p', fileRel), 'Files read').rejects.toMatchObject({ code: 'invalid_request' });
    expect(await exists(path.join(await realpath(projectRoot), 'new.txt')), 'nothing written').toBe(false);
  }

  // A6-P1-4 (TG1, FF): the project root sits in an existing denied root reached through the other spelling; the
  // denied root itself registered as the project is the D16 data-dir-as-project shape. Same-spelling rows are the
  // control that proves the matrix refuses today.
  const nested = [
    ['A6-P1-4', 'long', 'short', 'proj'],
    ['A6-P1-4', 'long', 'short', ''],
    ['A6-P1-4', 'short', 'long', 'proj'],
    ['A6-P1-4', 'short', 'long', ''],
    ['A6-P1-4 control', 'short', 'short', 'proj'],
    ['A6-P1-4 control', 'long', 'long', ''],
  ] as const;
  for (const [id, project, rootSpelling, sub] of nested) {
    const where = sub === '' ? 'is the denied root' : 'is inside the denied root';
    it(`${id}: a ${project}-spelled project that ${where} (${rootSpelling} spelling) blocks every tool`, async (ctx) => {
      await requireDataVolume(ctx);
      const { base, long } = await r4Base();
      const at = (s: 'short' | 'long') => (s === 'short' ? base : long);
      await put(base, 'config/openvern/proj/notes.txt', HIDDEN_TEXT);
      const denied = `${at(rootSpelling)}/config/openvern`;
      const deniedRoots = await defaultDataDirRoots(
        { XDG_CONFIG_HOME: `${at(rootSpelling)}/config` },
        `${base}/home`,
        'darwin',
      );
      expect(deniedRoots, 'the existing root, in the supplier spelling').toContain(denied);
      const projectRoot = `${at(project)}/config/openvern${sub === '' ? '' : `/${sub}`}`;
      const label = `r4-p1-4-${project}-${rootSpelling}-${sub || 'root'}`;
      await expectProjectBlocked(label, projectRoot, deniedRoots, sub === '' ? 'proj/notes.txt' : 'notes.txt');
    });
  }

  it('A6-P1-5 lock: an absolute path in the other spelling of the project stays outside, both directions', async (ctx) => {
    await requireDataVolume(ctx);
    const { base, long } = await r4Base();
    await put(base, 'visible.txt', VISIBLE_TEXT);
    const sandbox = r4Policy([`${base}/config/openvern`]);
    for (const [project, other] of [
      [base, long],
      [long, base],
    ] as const) {
      const abs = `${other}/visible.txt`;
      expect.soft(await resolveInProject(project, abs), `${project} <- ${abs}`).toMatchObject({
        ok: false,
        kind: 'outside',
      });
      expect.soft(await resolveForWrite(project, `${other}/new.txt`, sandbox)).toMatchObject({
        ok: false,
        kind: 'outside',
      });
      const ctx2: ToolContext = { projectRoot: project, signal: new AbortController().signal };
      expect.soft(await tools(sandbox)('read_file').run({ path: abs }, ctx2)).toMatchObject({
        ok: false,
        output: OUTSIDE_MESSAGE,
      });
    }
  });
});

// ------------------------------------------------------------------------- R4 P2: Unicode aliases of denied names

/** [stored or proposed alias, the canonical denied name APFS merges it with, acceptance id]. */
const P2_ALIASES = [
  ['secretſ.json', 'secrets.json', 'A6-P2-1'],
  ['ſecrets.json', 'secrets.json', 'A6-P2-3'],
  ['SECRETſ.JSON', 'secrets.json', 'A6-P2-3'],
  ['id_rſa', 'id_rsa', 'A6-P2-3'],
  ['.git-credentialſ', '.git-credentials', 'A6-P2-3'],
] as const;

/** Skips off macOS. On macOS the case runs and its merge preconditions fail it if the volume doesn't hold. */
function requireMacVolume(ctx: SkipCtx): void {
  if (!isMac) ctx.skip();
}

/** Proves on this volume that `variant` and `canonical` are one name (written as `canonical`, looked up as both). */
async function expectMerged(canonical: string, variant: string): Promise<void> {
  const { base } = await r4Base();
  await writeFile(path.join(base, canonical), 'probe');
  expect(await sameInode(path.join(base, canonical), path.join(base, variant)), `${variant} ~ ${canonical}`).toBe(true);
}

describe('AS-06 R4 P2 Unicode aliases of denied names (filesystem)', () => {
  for (const [variant, canonical, id] of P2_ALIASES) {
    it(`${id} a file stored as ${variant}: hidden from read_file, search, list_files, renderTree, walk and Files`, async (ctx) => {
      requireMacVolume(ctx);
      const { base } = await r4Base();
      await put(base, `dir/${variant}`, HIDDEN_TEXT);
      await put(base, 'dir/README.md', VISIBLE_TEXT);
      // TG12: stored as the variant, and the volume merges the pair.
      expect(await readdir(path.join(base, 'dir')), 'stored under the variant spelling').toContain(variant);
      expect(await sameInode(path.join(base, 'dir', variant), path.join(base, 'dir', canonical)), 'merged').toBe(true);
      await expectHiddenEverywhere({
        projectRoot: base,
        sandbox: {},
        dir: 'dir',
        hidden: [`dir/${variant}`],
        hiddenNames: [variant],
        visible: 'dir/README.md',
        openControls: false,
      });
    });
  }

  const writeId = (id: string) => (id === 'A6-P2-1' ? 'A6-P2-2' : id);
  for (const [variant, canonical, id] of P2_ALIASES) {
    it(`${writeId(id)} a missing ${variant}: write_file and stage refused with and without a root policy (TG8)`, async (ctx) => {
      requireMacVolume(ctx);
      await expectMerged(canonical, variant);
      for (const [leg, sandbox] of [
        ['policy', r4Policy([path.join(root, 'r4-elsewhere', 'openvern')])],
        ['unrestricted', undefined],
      ] as const) {
        const { base } = await r4Base();
        const label = `r4-p2-write-${leg}-${P2_ALIASES.findIndex(([v]) => v === variant)}`;
        const { svc, changes, ctx: tctx } = await realContext(base, label, sandbox);
        expect
          .soft(
            await tools(sandbox)('write_file').run({ path: variant, content: HIDDEN_TEXT }, tctx),
            `${leg}: write_file`,
          )
          .toMatchObject({ ok: false, output: BLOCKED_MESSAGE });
        expect.soft(await outcome(changes.stage(variant, HIDDEN_TEXT)), `${leg}: stage`).toBe('path_invalid');
        expect
          .soft(await resolveForWrite(base, variant, sandbox), `${leg}: resolveForWrite`)
          .toMatchObject({ ok: false, kind: 'blocked' });
        await changes.stage('control.txt', 'control\n');
        expect.soft(await applyPending(svc, label, base), `${leg}: the batch holds only the control`).toEqual({
          pending: ['control.txt'],
          written: ['control.txt'],
          conflicts: [],
        });
        expect(await readFile(path.join(base, 'control.txt'), 'utf8'), `${leg}: control applied`).toBe('control\n');
        await expect
          .soft(stat(path.join(base, canonical)), `${leg}: ${canonical}`)
          .rejects.toMatchObject({ code: 'ENOENT' });
        await expect
          .soft(stat(path.join(base, variant)), `${leg}: ${variant}`)
          .rejects.toMatchObject({ code: 'ENOENT' });
      }
    });
  }

  it('A6-P2-4 controls: old denials hold, the .env.example/.env.sample exceptions are unchanged', async (ctx) => {
    requireMacVolume(ctx);
    const { base } = await r4Base();
    await put(base, 'secrets.json', HIDDEN_TEXT);
    await put(base, '.env.example', 'EXAMPLE=dummy\n');
    await put(base, '.env.sample', 'SAMPLE=dummy\n');
    expect(await sameInode(path.join(base, 'secrets.json'), path.join(base, 'secretſ.json')), 'merged').toBe(true);
    expect(await sameInode(path.join(base, '.env.sample'), path.join(base, '.env.ſample')), 'merged').toBe(true);
    const { changes, ctx: tctx } = await realContext(base, 'r4-p2-4');
    const t = tools();
    const refused = { ok: false, output: BLOCKED_MESSAGE };
    // Still blocked: the canonical file read through the alias (realpath gives its stored, denied spelling).
    expect.soft(await t('read_file').run({ path: 'secretſ.json' }, tctx), 'secretſ.json').toMatchObject(refused);
    // Still allowed: the exact safe names and the ASCII case variant.
    for (const [rel, text] of [
      ['.env.example', 'EXAMPLE=dummy'],
      ['.env.sample', 'SAMPLE=dummy'],
      ['.ENV.EXAMPLE', 'EXAMPLE=dummy'],
    ] as const) {
      const r = await t('read_file').run({ path: rel }, tctx);
      expect.soft(r.ok, `${rel} readable`).toBe(true);
      expect.soft(r.output, rel).toContain(text);
    }
    // Still denied: an alias of an allowed name (documented over-denial) and a fold that must not lift a denial.
    expect.soft(await t('read_file').run({ path: '.env.ſample' }, tctx), '.env.ſample').toMatchObject(refused);
    expect
      .soft(await t('write_file').run({ path: '.env.ｅxample', content: 'X=dummy\n' }, tctx), '.env.ｅxample')
      .toMatchObject(refused);
    expect.soft(await outcome(changes.stage('.env.ｅxample', 'X=dummy\n')), 'stage .env.ｅxample').toBe('path_invalid');
    expect((await readdir(base)).sort(), 'nothing written').toEqual(['.env.example', '.env.sample', 'secrets.json']);
  });
});

// ------------------------------------------------------------------------------ R4 P3: the respelling diagnostic

describe('AS-06 R4 P3 respelling diagnostic (filesystem)', () => {
  /** Stage a control, then `requested`; return the rejection and the pending state before and after it. */
  async function stageRespelling(base: string, label: string, requested: string) {
    const { svc, changes } = await realContext(base, label);
    await changes.stage('control.txt', 'control\n');
    const before = (await svc.get(label)).pending;
    const err = await changes.stage(requested, 'changed dummy\n').then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );
    const after = (await svc.get(label)).pending;
    return { err, before, after };
  }

  const respelled = [
    ['A6-P3-1', 'post.txt', 'poſt.txt'],
    ['A6-P3-1', 'notes/post.txt', 'notes/poſt.txt'],
    ['A6-P3-2', 'strasse.txt', 'straße.txt'],
    ['A6-P3-2', 'straße.txt', 'strasse.txt'],
  ] as const;
  for (const [id, stored, requested] of respelled) {
    it(`${id} staging ${requested} over an existing ${stored}: rejected, and the message names ${stored}`, async (ctx) => {
      requireMacVolume(ctx);
      const { base } = await r4Base();
      await put(base, stored, 'original dummy\n');
      expect(await sameInode(path.join(base, stored), path.join(base, requested)), 'the volume merges the pair').toBe(
        true,
      );
      const label = `r4-p3-${respelled.findIndex(([, s, r]) => s === stored && r === requested)}`;
      const { err, before, after } = await stageRespelling(base, label, requested);
      expect(err, 'rejected').toMatchObject({ code: 'path_invalid' });
      expect.soft(err?.message, 'names the canonical spelling').toContain(`on-disk spelling "${stored}"`);
      expect.soft(err?.message, 'not reported as a symlink only').not.toMatch(/^Path goes through a symbolic link/);
      expect(after?.revision, 'pending revision unchanged').toBe(before?.revision);
      expect(
        after?.files.map((f) => f.path),
        'pending unchanged',
      ).toEqual(['control.txt']);
      expect(await readFile(path.join(base, stored), 'utf8'), 'file unchanged').toBe('original dummy\n');
    });
  }

  it('A6-P3-3 control: a real symlink keeps the symbolic-link message', async (ctx) => {
    requireMacVolume(ctx);
    const { base } = await r4Base();
    await put(base, 'real.txt', 'dummy\n');
    await put(base, 'dir/post.txt', 'dummy\n');
    await symlink('real.txt', path.join(base, 'link.txt'));
    await symlink('dir', path.join(base, 'dlink'));
    for (const [i, rel] of ['link.txt', 'dlink/post.txt'].entries()) {
      const { err, after } = await stageRespelling(base, `r4-p3-3-${i}`, rel);
      expect
        .soft(err, rel)
        .toMatchObject({ code: 'path_invalid', message: `Path goes through a symbolic link: ${rel}` });
      expect
        .soft(
          after?.files.map((f) => f.path),
          `${rel}: pending unchanged`,
        )
        .toEqual(['control.txt']);
    }
  });

  it('A6-P3-4 control: an alias of an existing denied file is blocked first, and its name never appears', async (ctx) => {
    requireMacVolume(ctx);
    const { base } = await r4Base();
    await put(base, 'secrets.json', HIDDEN_TEXT);
    expect(await sameInode(path.join(base, 'secrets.json'), path.join(base, 'secretſ.json')), 'merged').toBe(true);
    const { err, after } = await stageRespelling(base, 'r4-p3-4', 'secretſ.json');
    expect(err).toMatchObject({ code: 'path_invalid', message: BLOCKED_MESSAGE });
    expect(err?.message).not.toContain('secrets.json');
    expect(after?.files.map((f) => f.path)).toEqual(['control.txt']);
    expect(await readFile(path.join(base, 'secrets.json'), 'utf8')).toBe(HIDDEN_TEXT);
  });
});
