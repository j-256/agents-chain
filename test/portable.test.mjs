import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, chmod, stat, symlink, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = new URL('../', import.meta.url)

test('portable state is private, atomic and refuses links or public metadata', async t => {
  const { Store, atomicJson, readPrivateJson, stateRoot } = await import('../lib/state.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'agents-chain-storage.'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new Store('fixture', join(dir, 'state'))
  await store.prepare()
  assert.equal((await stat(store.dir)).mode & 0o777, 0o700)
  const file = join(store.dir, 'session.json')
  await atomicJson(file, { version: 1 })
  assert.deepEqual(await readPrivateJson(file), { version: 1 })
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  await chmod(file, 0o644)
  await assert.rejects(readPrivateJson(file))
  await chmod(file, 0o600)
  const link = join(dir, 'link')
  await symlink(file, link)
  await assert.rejects(readPrivateJson(link))
  assert.throws(() => stateRoot({ XDG_STATE_HOME: 'relative' }))
  const linked = new Store('fixture', join(dir, 'linked'))
  await symlink(store.root, linked.root)
  await assert.rejects(linked.prepare())
})

test('portable exclusions combine safe defaults with validated explicit paths', async () => {
  const { excludedRoots } = await import('../lib/policy.mjs')
  const roots = excludedRoots({ AGENTS_CHAIN_EXCLUDED_ROOTS: '["/sensitive"]' }, '/sandbox/home')
  assert.ok(roots.includes('/sensitive'))
  assert.ok(roots.includes('/sandbox/home/.ssh'))
  assert.ok(roots.includes('/sandbox/home/Downloads'))
  for (const value of ['not JSON', '{}', '["relative"]', '[3]']) assert.throws(() => excludedRoots({ AGENTS_CHAIN_EXCLUDED_ROOTS: value }, '/sandbox/home'))
})

test('runtime hook entrypoints explain their protocol without waiting for stdin', () => {
  for (const runtime of ['claude', 'codex']) {
    for (const flag of ['--help', '-h']) {
      const result = spawnSync(process.execPath, [new URL(`hooks/${runtime}.mjs`, root).pathname, flag], { encoding: 'utf8', timeout: 3000 })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /--log-only/)
      assert.match(result.stdout, /AGENTS_CHAIN_EXCLUDED_ROOTS/)
    }
  }
})

test('global deduplication recognizes the Codex symlink and Claude import without dropping other home guidance', async t => {
  const { governingFiles } = await import('../lib/agents-chain-files.mjs')
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agents-chain-global.')))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'project'))
  const global = join(home, 'AGENTS.md')
  await writeFile(global, 'Shared home instructions\n')
  for (const runtime of ['codex', 'claude']) {
    const options = { home, trusted: [home], env: {}, runtime }
    assert.ok((await governingFiles(join(home, 'project'), options)).some(file => file.path === global))
    await mkdir(join(home, `.${runtime}`))
    if (runtime === 'codex') await symlink('../AGENTS.md', join(home, '.codex/AGENTS.md'))
    else await writeFile(join(home, '.claude/CLAUDE.md'), '@~/AGENTS.md contains shared guidance\n')
    assert.ok(!(await governingFiles(join(home, 'project'), options)).some(file => file.path === global))
    if (runtime === 'claude') {
      for (const text of ['```text\n@~/AGENTS.md\n```\n', 'Example only: `\n@~/AGENTS.md\n`\n', 'Example only: ``one ` tick\n@~/AGENTS.md\n``\n']) {
        await writeFile(join(home, '.claude/CLAUDE.md'), text)
        assert.ok((await governingFiles(join(home, 'project'), options)).some(file => file.path === global), text)
      }
    }
  }
})

test('fail-open logging never follows a rejected state root or log symlink', async t => {
  const { handleAgentsChain } = await import('../lib/agents-chain.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'agents-chain-log-safety.'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const target = join(dir, 'destination')
  await mkdir(target)
  const root = join(dir, 'linked-root')
  await symlink(target, root)
  const payload = { session_id: 'fixture', hook_event_name: 'SessionStart', source: 'startup', cwd: dir }
  assert.deepEqual(await handleAgentsChain('codex', payload, { root }), { exitCode: 0 })
  await assert.rejects(stat(join(target, 'log.jsonl')), { code: 'ENOENT' })
  const safeRoot = join(dir, 'state')
  await mkdir(safeRoot)
  const destination = join(target, 'sentinel')
  await writeFile(destination, 'unchanged')
  await symlink(destination, join(safeRoot, 'log.jsonl'))
  assert.deepEqual(await handleAgentsChain('codex', payload, { root: safeRoot }), { exitCode: 0 })
  assert.equal(await readFile(destination, 'utf8'), 'unchanged')
})
