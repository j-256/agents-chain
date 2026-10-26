import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileIdentity, governingFiles, mainCheckoutTop, nativeFiles, readGoverning, realDirectory } from '../lib/agents-chain-files.mjs'

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agents-chain-files.')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const put = async (rel, text) => {
    await mkdir(dirname(join(base, rel)), { recursive: true })
    await writeFile(join(base, rel), text)
    return join(base, rel)
  }
  const home = join(base, 'home')
  await mkdir(join(home, '.codex'), { recursive: true })
  await symlink('../AGENTS.md', join(home, '.codex/AGENTS.md'))
  const options = { home, trusted: [base], untrusted: [join(home, 'Downloads')], runtime: 'codex', env: {} }
  // Only files inside the fixture matter; ignore any AGENTS.md above the temp directory
  const inside = files => files.map(file => file.path).filter(path => path.startsWith(`${base}/`))
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' })
  return { base, put, home, options, inside, git }
}

test('chains run from / down to the directory, outermost first', async t => {
  const f = await fixture(t)
  const root = await f.put('AGENTS.md', 'root\n')
  const a = await f.put('a/AGENTS.md', 'a\n')
  const b = await f.put('a/b/AGENTS.md', 'b\n')
  await mkdir(join(f.base, 'a/b/c'))
  assert.deepEqual(f.inside(await governingFiles(join(f.base, 'a/b/c'), f.options)), [root, a, b])
})

test('global, hardlinked, empty, invalid, vendored, git and untrusted files are excluded', async t => {
  const f = await fixture(t)
  const global = await f.put('home/AGENTS.md', 'global\n')
  const a = await f.put('a/AGENTS.md', 'a\n')
  await mkdir(join(f.base, 'a/linked'))
  await link(global, join(f.base, 'a/linked/AGENTS.md'))
  await f.put('a/empty/AGENTS.md', '')
  await f.put('a/bad/AGENTS.md', Buffer.from([0xff, 0xfe, 0x41]))
  await f.put('a/node_modules/pkg/AGENTS.md', 'vendored\n')
  await f.put('a/.git/AGENTS.md', 'git\n')
  await f.put('home/Downloads/item/AGENTS.md', 'downloaded\n')
  for (const dir of ['a/linked', 'a/empty', 'a/bad', 'a/node_modules/pkg', 'a/.git']) {
    assert.deepEqual(f.inside(await governingFiles(join(f.base, dir), f.options)), [a], dir)
  }
  assert.deepEqual(f.inside(await governingFiles(join(f.base, 'home/Downloads/item'), f.options)), [])
})

test('a path that does not exist yet uses its nearest existing directory', async t => {
  const f = await fixture(t)
  await f.put('a/AGENTS.md', 'a\n')
  assert.equal(await realDirectory(join(f.base, 'a/new/dir/file.txt')), join(f.base, 'a'))
  assert.deepEqual(await governingFiles(join(f.base, 'a/new/dir'), f.options), await governingFiles(join(f.base, 'a'), f.options))
})

test('symlinked paths resolve to the same chain', async t => {
  const f = await fixture(t)
  await f.put('a/AGENTS.md', 'a\n')
  await f.put('a/b/AGENTS.md', 'b\n')
  await symlink(join(f.base, 'a'), join(f.base, 'link'))
  assert.equal(await realDirectory(join(f.base, 'link/b')), join(f.base, 'a/b'))
  assert.deepEqual(await governingFiles(join(f.base, 'link/b'), f.options), await governingFiles(join(f.base, 'a/b'), f.options))
})

test('a linked worktree adds only the main checkout ancestors above its top level', async t => {
  const f = await fixture(t)
  const aboveMain = await f.put('m/AGENTS.md', 'above main\n')
  await f.put('m/main/AGENTS.md', 'main root\n')
  await f.put('m/main/sub/AGENTS.md', 'main sub\n')
  f.git(join(f.base, 'm'), 'init', '-q', 'main')
  f.git(join(f.base, 'm/main'), 'add', '-A')
  f.git(join(f.base, 'm/main'), 'commit', '-q', '-m', 'init')
  await mkdir(join(f.base, 'w'))
  f.git(join(f.base, 'm/main'), 'worktree', 'add', '-q', join(f.base, 'w/feature'), '-b', 'feature')
  const sub = join(f.base, 'w/feature/sub')
  assert.equal(await mainCheckoutTop(sub), join(f.base, 'm/main'))
  assert.equal(await mainCheckoutTop(join(f.base, 'm/main')), null)
  assert.equal(await mainCheckoutTop(join(f.base, 'w')), null)
  assert.deepEqual(f.inside(await governingFiles(sub, f.options)), [aboveMain, join(f.base, 'w/feature/AGENTS.md'), join(sub, 'AGENTS.md')])
  assert.deepEqual(f.inside(await nativeFiles('codex', sub, f.options)), [join(f.base, 'w/feature/AGENTS.md'), join(sub, 'AGENTS.md')])
})

test('Claude native files are the starting directory chain', async t => {
  const f = await fixture(t)
  const files = [await f.put('AGENTS.md', 'r\n'), await f.put('a/AGENTS.md', 'a\n'), await f.put('a/b/AGENTS.md', 'b\n')]
  assert.deepEqual(f.inside(await nativeFiles('claude', join(f.base, 'a/b'), f.options)), files)
})

test('Codex native files run from the project root and stop at the 32 KiB budget', async t => {
  const f = await fixture(t)
  await f.put('AGENTS.md', 'above root\n')
  const a = await f.put('a/AGENTS.md', 'a\n')
  const b = await f.put('a/b/AGENTS.md', 'b\n')
  f.git(f.base, 'init', '-q', 'a')
  assert.deepEqual(f.inside(await nativeFiles('codex', join(f.base, 'a/b'), f.options)), [a, b])
  await writeFile(a, 'x'.repeat(20000))
  await writeFile(b, 'y'.repeat(20000))
  assert.deepEqual(f.inside(await nativeFiles('codex', join(f.base, 'a/b'), f.options)), [a])
  const loose = await f.put('x/y/AGENTS.md', 'loose\n')
  await f.put('x/AGENTS.md', 'parent\n')
  assert.deepEqual(f.inside(await nativeFiles('codex', join(f.base, 'x/y'), f.options)), [loose])
})

test('readGoverning returns text and a SHA-256 hash, or null', async t => {
  const f = await fixture(t)
  const good = await f.put('g/AGENTS.md', 'rules\n')
  assert.deepEqual(await readGoverning(good), { text: 'rules\n', hash: createHash('sha256').update('rules\n').digest('hex') })
  assert.equal(await readGoverning(await f.put('e/AGENTS.md', '')), null)
  assert.equal(await readGoverning(join(f.base, 'missing/AGENTS.md')), null)
})

test('fileIdentity matches hardlinks and differs between files', async t => {
  const f = await fixture(t)
  const one = await f.put('one/AGENTS.md', '1\n')
  const two = await f.put('two/AGENTS.md', '2\n')
  await mkdir(join(f.base, 'three'))
  await link(one, join(f.base, 'three/AGENTS.md'))
  assert.equal(await fileIdentity(join(f.base, 'three/AGENTS.md')), await fileIdentity(one))
  assert.notEqual(await fileIdentity(two), await fileIdentity(one))
})

test('symlinks to non-AGENTS.md files and files outside trusted roots are never delivered', async t => {
  const f = await fixture(t)
  const secret = await f.put('secrets/creds.txt', 'SECRET-TOKEN-123\n')
  await mkdir(join(f.base, 'clone'))
  await symlink(secret, join(f.base, 'clone/AGENTS.md'))
  assert.deepEqual(f.inside(await governingFiles(join(f.base, 'clone'), f.options)), [])
  const real = await f.put('notes/AGENTS.md', 'aliased rules\n')
  await mkdir(join(f.base, 'alias'))
  await symlink(real, join(f.base, 'alias/AGENTS.md'))
  assert.deepEqual(f.inside(await governingFiles(join(f.base, 'alias'), f.options)), [real])
  await f.put('outside/AGENTS.md', 'outside rules\n')
  const narrow = { ...f.options, trusted: [join(f.base, 'notes')] }
  assert.deepEqual(f.inside(await governingFiles(join(f.base, 'outside'), narrow)), [])
})

test('discovery counts exclusions once per reason and path without changing chains', async t => {
  const { chainOptions } = await import('../lib/agents-chain-files.mjs')
  const f = await fixture(t)
  const observations = {}
  const options = await chainOptions({ ...f.options, observations })
  await f.put('home/AGENTS.md', 'global')
  const prepared = await chainOptions({ ...f.options, observations })
  await governingFiles(f.home, prepared)
  await f.put('bad/AGENTS.md', Buffer.from([0xff]))
  await governingFiles(join(f.base, 'bad'), prepared)
  await governingFiles(join(f.base, 'bad'), prepared)
  await f.put('node_modules/pkg/AGENTS.md', 'skip')
  await governingFiles(join(f.base, 'node_modules/pkg'), prepared)
  await f.put('outside/AGENTS.md', 'outside')
  const narrow = await chainOptions({ ...f.options, observations, trusted: [f.home] })
  await governingFiles(join(f.base, 'outside'), narrow)
  const target = await f.put('target.txt', 'secret')
  await mkdir(join(f.base, 'alias'))
  await symlink(target, join(f.base, 'alias/AGENTS.md'))
  await governingFiles(join(f.base, 'alias'), prepared)
  await f.put('owned/AGENTS.md', 'owned')
  options.uid = -1
  await governingFiles(join(f.base, 'owned'), options)
  assert.equal(observations.excluded['global-file'].size, 1)
  assert.equal(observations.excluded['empty-or-non-utf8'].size, 1)
  assert.equal(observations.excluded['skipped-directory'].size, 1)
  assert.equal(observations.excluded['outside-home'].size, 1)
  assert.equal(observations.excluded['symlink-name'].size, 1)
  assert.equal(observations.excluded['not-user-owned'].size, 1)
})
