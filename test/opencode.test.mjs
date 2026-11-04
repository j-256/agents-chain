import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { handleAgentsChain } from '../lib/agents-chain.mjs'
import { nativeFiles, boundedNativeInstructions } from '../lib/agents-chain-files.mjs'
import { readReport } from '../lib/agents-chain-report.mjs'

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agents-opencode.')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const put = async (path, text) => { const full = join(base, path); await mkdir(dirname(full), { recursive: true }); await writeFile(full, text); return full }
  const outer = await put('AGENTS.md', 'OUTER\n')
  const project = await put('project/AGENTS.md', 'PROJECT\n')
  const root = join(base, 'state')
  const options = { root, home: base, trusted: [base], env: {}, now: () => 100000 }
  const hook = (event, fields = {}, extra = {}) => handleAgentsChain('opencode', { session_id: 'ses_one', cwd: join(base, 'project'), hook_event_name: event, ...fields }, { ...options, ...extra })
  const call = (tool, path, extra = {}) => hook('PreToolUse', { tool_name: tool, tool_input: { file_path: path, content: 'new' } }, extra)
  const context = result => result.stderr ?? (result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : '')
  return { base, outer, project, root, options, put, hook, call, context }
}

test('OpenCode seeds only exact observed instructions, never guessed ancestors or globals', async t => {
  const f = await fixture(t)
  const observed = { nativeInstructions: [{ path: f.project, text: 'PROJECT\n' }] }
  const start = await f.hook('SessionStart', { source: 'startup' }, observed)
  assert.match(f.context(start), /OUTER/)
  assert.doesNotMatch(f.context(start), /PROJECT/)
  assert.equal((await nativeFiles('opencode', f.base, f.options)).length, 0)
  const global = await f.put('.config/opencode/AGENTS.md', 'GLOBAL\n')
  const configured = await f.put('configured/AGENTS.md', 'CONFIGURED\n')
  assert.deepEqual((await nativeFiles('opencode', f.base, { ...f.options, nativeInstructions: [{ path: global, text: 'GLOBAL\n' }, { path: configured, text: 'CONFIGURED\n' }] })).map(file => file.path), [global, configured])
})

test('native evidence rejects mismatched, excluded, remote and wrong-name symlink targets', async t => {
  const f = await fixture(t)
  const wrong = await f.put('wrong.txt', 'SYMLINK\n')
  await mkdir(join(f.base, 'linked'))
  await symlink(wrong, join(f.base, 'linked/AGENTS.md'))
  const excluded = await f.put('node_modules/pkg/AGENTS.md', 'EXCLUDED\n')
  const files = await nativeFiles('opencode', f.base, { ...f.options, nativeInstructions: [
    { path: f.project, text: 'wrong' }, { path: join(f.base, 'linked/AGENTS.md'), text: 'SYMLINK\n' },
    { path: excluded, text: 'EXCLUDED\n' }, { path: 'https://example.com/AGENTS.md', text: 'REMOTE' },
  ] })
  assert.deepEqual(files, [])
})

test('first write bounces, identical retry passes, and same-batch read/write stays guarded', async t => {
  const f = await fixture(t)
  await f.hook('SessionStart', { source: 'startup' })
  const rules = await f.put('other/AGENTS.md', 'OTHER\n')
  const target = join(dirname(rules), 'new')
  const first = await f.call('Write', target)
  assert.equal(first.exitCode, 2)
  assert.match(f.context(first), /OTHER/)
  assert.equal((await f.call('Write', target)).exitCode, 0)
  const readRules = await f.put('read/AGENTS.md', 'READ\n')
  assert.match(f.context(await f.call('Read', join(dirname(readRules), 'data'))), /READ/)
  assert.equal((await f.call('Write', join(dirname(readRules), 'data'))).exitCode, 2)
})

test('native observations refresh after changes and unverified Read does not suppress delivery', async t => {
  const f = await fixture(t)
  await f.hook('SessionStart', { source: 'startup' }, { nativeInstructions: [{ path: f.project, text: 'PROJECT\n' }] })
  await writeFile(f.project, 'CHANGED\n')
  assert.match(f.context(await f.call('Read', join(f.base, 'project/data'))), /CHANGED/)
  const rules = await f.put('unread/AGENTS.md', 'UNREAD\n')
  assert.match(f.context(await f.call('Read', rules)), /UNREAD/)
})

test('resume retains delivered context while compact and children have independent epochs', async t => {
  const f = await fixture(t)
  await f.hook('SessionStart', { source: 'startup' })
  const path = await f.put('more/AGENTS.md', 'MORE\n')
  const target = join(dirname(path), 'data')
  await f.call('Read', target)
  await f.hook('SessionStart', { source: 'resume' })
  assert.equal(f.context(await f.call('Read', target)), '')
  await f.hook('SessionStart', { source: 'compact' })
  assert.match(f.context(await f.call('Read', target)), /MORE/)
  assert.match(f.context(await f.hook('PreToolUse', { session_id: 'ses_child', tool_name: 'Read', tool_input: { file_path: target } })), /MORE/)
})

test('OpenCode cap produces bounded outlines and report accepts its runtime', async t => {
  const f = await fixture(t)
  await f.hook('SessionStart', { source: 'startup' })
  const rules = await f.put('big/AGENTS.md', '# Heading\n' + 'BIG\n'.repeat(1000))
  const result = await f.call('Write', join(dirname(rules), 'data'), { epochBytesCap: 128 })
  assert.equal(result.exitCode, 2)
  assert.match(f.context(result), /outline/)
  assert.ok(f.context(result).length < 32000)
  const logs = await readFile(join(f.root, 'log.jsonl'), 'utf8')
  assert.doesNotMatch(logs, /OUTER|PROJECT|BIG/)
  const report = await readReport([join(f.root, 'log.jsonl')])
  assert.ok(report.groups.some(group => group.runtime === 'opencode'))
})

test('new successful read observations preserve earlier same-batch delivery records', async t => {
  const f = await fixture(t)
  const rules = await f.put('batch/AGENTS.md', 'BATCH\n')
  await f.call('Read', rules)
  const next = await f.call('Write', join(dirname(rules), 'data'), { nativeInstructions: [{ path: rules, text: 'BATCH\n' }] })
  assert.equal(next.exitCode, 2)
  assert.match(f.context(next), /BATCH/)
})

test('OpenCode resume resets unless every emitted instruction context is retained', async t => {
  const f = await fixture(t)
  await f.hook('SessionStart', { source: 'startup' })
  const path = await f.put('resume/AGENTS.md', 'RESUME\n')
  await f.call('Write', join(dirname(path), 'data'))
  await f.hook('SessionStart', { source: 'resume' }, { retainedContexts: [] })
  assert.match(f.context(await f.call('Write', join(dirname(path), 'data'))), /RESUME/)
})

test('native evidence deduplicates before collection and bounds unique text storage', () => {
  const entry = { path: '/fixture/AGENTS.md', text: 'RULES' }
  assert.equal(boundedNativeInstructions(Array.from({ length: 2000 }, () => entry)).length, 1)
  assert.ok(boundedNativeInstructions(Array.from({ length: 1000 }, (_, i) => ({ ...entry, path: `/fixture/${i}/AGENTS.md` }))).length <= 256)
  assert.equal(boundedNativeInstructions([{ ...entry, text: 'x'.repeat(1048577) }]).length, 0)
})

test('fully retained instruction deliveries preserve the epoch and missing native evidence redelivers', async t => {
  const f = await fixture(t)
  const start = await f.hook('SessionStart', { source: 'startup' }, { nativeInstructions: [{ path: f.project, text: 'PROJECT\n' }] })
  const retained = [createHash('sha256').update(f.context(start)).digest('hex')]
  const next = await f.hook('SessionStart', { source: 'resume' }, { retainedContexts: retained })
  assert.match(f.context(next), /PROJECT/)
  assert.doesNotMatch(f.context(next), /OUTER/)
})
