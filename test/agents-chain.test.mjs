import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, stat, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { handleAgentsChain } from '../lib/agents-chain.mjs'

const RETRY = 'The tool call was not run so these instructions could be read first. Re-issue the same call now.'
const HOUR = 60 * 60 * 1000

for (const runtime of ['claude', 'codex']) {
  test(`${runtime}: token telemetry attributes actual rendered deliveries and reset resends`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    await f.put('token/AGENTS.md', 'PRIVATE INSTRUCTION é🧪\n')
    const file = await f.put('token/data.txt', 'data')
    const first = await f.read(file)
    const line = (await f.logLines()).at(-1)
    assert.ok(line.tokens)
    assert.equal(line.tokens.method, 'utf8-bytes/4')
    assert.equal(line.tokens.estimate, Buffer.byteLength(f.context(first)) / 4)
    assert.equal(line.tokens.parts.reduce((n, p) => n + p.bytes, 0), line.bytes)
    assert.equal(line.tokens.parts.find(p => p.kind === 'full').reason, 'new')
    assert.doesNotMatch(JSON.stringify(line), /PRIVATE INSTRUCTION|é|🧪/)
    await f.hook('SessionStart', { source: 'compact' })
    await f.read(file)
    assert.equal((await f.logLines()).at(-1).tokens.parts.find(p => p.kind === 'full').reason, 'after-reset')
    quiet(await f.read(file))
    assert.equal((await f.logLines()).at(-1).tokens.estimate, 0)
  })
}

async function fixture(t, runtime, options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agents-chain.')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const put = async (rel, text) => {
    await mkdir(dirname(join(base, rel)), { recursive: true })
    await writeFile(join(base, rel), text)
    return join(base, rel)
  }
  await put('home/AGENTS.md', 'GLOBAL\n')
  await put('home/.claude/CLAUDE.md', '@../AGENTS.md\n')
  await mkdir(join(base, 'home/.codex'))
  await symlink('../AGENTS.md', join(base, 'home/.codex/AGENTS.md'))
  await put('outer/AGENTS.md', 'OUTER rules\n')
  await put('outer/proj/AGENTS.md', 'PROJ rules\n')
  execFileSync('git', ['init', '-q', join(base, 'outer/proj')])
  const root = join(base, 'state')
  const home = join(base, 'home')
  const cwd = join(base, 'outer/proj')
  let clock = 1_000_000
  const hook = (event, fields = {}, env = {}) => handleAgentsChain(runtime, { session_id: 'session-1', hook_event_name: event, cwd, ...fields }, { root, home, trusted: [base], env, now: () => clock, ...options })
  const read = (path, fields = {}, env) => hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: path }, tool_use_id: 'tu', ...fields }, env)
  const write = (path, fields = {}, env) => hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: path, content: 'x' }, tool_use_id: 'tu', ...fields }, env)
  const context = result => JSON.parse(result.stdout).hookSpecificOutput.additionalContext
  const logLines = async () => (await readFile(join(root, 'log.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const sessionFiles = async () => {
    const files = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, entry.name, 'session.json'))) files.push(join(root, entry.name, 'session.json'))
    }
    return files
  }
  return { base, put, root, cwd, hook, read, write, context, logLines, sessionFiles, tick: ms => { clock += ms } }
}

const quiet = result => {
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout ?? '', '')
  assert.equal(result.stderr ?? '', '')
}

test('codex SessionStart delivers files above the project root only', async t => {
  const f = await fixture(t, 'codex')
  const result = await f.hook('SessionStart', { source: 'startup' })
  assert.equal(result.exitCode, 0)
  const text = f.context(result)
  assert.match(text, /OUTER rules/)
  assert.doesNotMatch(text, /PROJ rules|GLOBAL/)
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, 'SessionStart')
})

test('claude SessionStart is quiet when every ancestor loaded natively', async t => {
  const f = await fixture(t, 'claude')
  quiet(await f.hook('SessionStart', { source: 'startup' }))
})

for (const runtime of ['claude', 'codex']) {
  test(`${runtime}: a read outside the tree delivers its chain once`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    await f.put('other/AGENTS.md', 'OTHER rules\n')
    const file = await f.put('other/file.txt', 'data\n')
    const first = await f.read(file)
    assert.equal(first.exitCode, 0)
    assert.match(f.context(first), /OTHER rules/)
    assert.equal(JSON.parse(first.stdout).hookSpecificOutput.hookEventName, 'PreToolUse')
    quiet(await f.read(file))
  })

  test(`${runtime}: the first write bounces with the chain and the retry passes`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    await f.put('other2/AGENTS.md', 'OTHER2 rules\n')
    const target = join(f.base, 'other2/new/dir/file.txt')
    const bounce = await f.write(target)
    assert.equal(bounce.exitCode, 2)
    assert.match(bounce.stderr, /OTHER2 rules/)
    assert.ok(bounce.stderr.endsWith(RETRY))
    f.tick(5000)
    quiet(await f.write(target))
  })

  test(`${runtime}: a parallel write inside the bounce window also bounces`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    await f.put('par/AGENTS.md', 'PAR rules\n')
    assert.equal((await f.write(join(f.base, 'par/a.txt'))).exitCode, 2)
    f.tick(500)
    const second = await f.write(join(f.base, 'par/b.txt'))
    assert.equal(second.exitCode, 2)
    assert.match(second.stderr, /PAR rules/)
    f.tick(3000)
    quiet(await f.write(join(f.base, 'par/c.txt')))
  })

  test(`${runtime}: a changed file is re-sent once as context, never bounced`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    const rules = await f.put('chg/AGENTS.md', 'version one\n')
    const file = await f.put('chg/file.txt', 'data\n')
    await f.read(file)
    await writeFile(rules, 'version two\n')
    const write = await f.write(file)
    assert.equal(write.exitCode, 0)
    assert.match(f.context(write), /version two/)
    quiet(await f.read(file))
  })

  test(`${runtime}: compact resets deliveries and resume keeps them`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    await f.put('cmp/AGENTS.md', 'CMP rules\n')
    const file = await f.put('cmp/file.txt', 'data\n')
    await f.read(file)
    await f.hook('SessionStart', { source: 'resume' })
    quiet(await f.read(file))
    await f.hook('SessionStart', { source: 'compact' })
    assert.match(f.context(await f.read(file)), /CMP rules/)
  })

  test(`${runtime}: subagents track deliveries separately`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    await f.put('sub/AGENTS.md', 'SUB rules\n')
    const file = await f.put('sub/file.txt', 'data\n')
    await f.read(file)
    assert.match(f.context(await f.read(file, { agent_id: 'agent-1', agent_type: 'general-purpose' })), /SUB rules/)
  })

  test(`${runtime}: a full Read of an AGENTS.md counts as seeing it, and editing an unseen one bounces first`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    const read = await f.put('self/AGENTS.md', 'SELF rules\n')
    quiet(await f.hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: read } }))
    const partial = await f.put('part/AGENTS.md', 'PART rules\n')
    assert.match(f.context(await f.hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: partial, offset: 1, limit: 1 } })), /PART rules/)
    const unseen = await f.put('edit/AGENTS.md', 'EDIT rules\n')
    const bounce = await f.hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: unseen, old_string: 'EDIT', new_string: 'E' } })
    assert.equal(bounce.exitCode, 2)
    assert.match(bounce.stderr, /EDIT rules/)
  })

  test(`${runtime}: parallel reads for different directories all deliver and persist`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    const files = []
    for (let i = 0; i < 10; i += 1) {
      await f.put(`p${i}/AGENTS.md`, `P${i} rules\n`)
      files.push(await f.put(`p${i}/file.txt`, 'data\n'))
    }
    const results = await Promise.all(files.map(file => f.read(file)))
    results.forEach((result, i) => assert.match(f.context(result), new RegExp(`P${i} rules`)))
    const [state] = await f.sessionFiles()
    const recorded = Object.keys(JSON.parse(await readFile(state, 'utf8')).files)
    for (let i = 0; i < 10; i += 1) assert.ok(recorded.includes(join(f.base, `p${i}/AGENTS.md`)), `p${i}`)
  })

  test(`${runtime}: corrupt state fails open and is logged`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    const [state] = await f.sessionFiles()
    await writeFile(state, '{not json', { mode: 0o600 })
    await f.put('bad/AGENTS.md', 'BAD rules\n')
    quiet(await f.write(join(f.base, 'bad/file.txt')))
    assert.ok((await f.logLines()).some(line => line.error))
  })

  test(`${runtime}: the kill switch disables everything`, async t => {
    const f = await fixture(t, runtime)
    quiet(await f.hook('SessionStart', { source: 'startup' }, { AGENTS_CHAIN_DISABLE: '1' }))
    assert.equal(existsSync(f.root), false)
  })

  test(`${runtime}: log mode decides and logs without output`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' }, { AGENTS_CHAIN_MODE: 'log' })
    await f.put('lm/AGENTS.md', 'LM secret rules\n')
    quiet(await f.write(join(f.base, 'lm/file.txt'), { tool_use_id: 'tu-log' }, { AGENTS_CHAIN_MODE: 'log' }))
    const line = (await f.logLines()).find(entry => entry.toolUseId === 'tu-log')
    assert.equal(line.decision, 'bounce')
    assert.equal(line.mode, 'log')
    for (const field of ['ts', 'runtime', 'session', 'toolUseId', 'event', 'tool', 'source', 'kind', 'candidates', 'sent', 'noted', 'covered', 'bounced', 'bytes', 'decision', 'mode', 'ms']) {
      assert.ok(field in line, field)
    }
    assert.deepEqual(line.bounced, [join(f.base, 'lm/AGENTS.md')])
    assert.doesNotMatch(await readFile(join(f.root, 'log.jsonl'), 'utf8'), /LM secret rules|"content"/)
  })
}

test('claude notes a file that exceeds its context budget and the write delivers it in full', async t => {
  const f = await fixture(t, 'claude')
  await f.hook('SessionStart', { source: 'startup' })
  const big = await f.put('big/AGENTS.md', 'N'.repeat(12000))
  const file = await f.put('big/file.txt', 'data\n')
  const note = f.context(await f.read(file))
  assert.match(note, new RegExp(`Not included because of the hook size limit: ${big} \\(12000 bytes\\)`))
  const bounce = await f.write(file)
  assert.equal(bounce.exitCode, 2)
  assert.ok(bounce.stderr.includes('N'.repeat(12000)))
})

test('codex re-sends deliveries older than four hours as context, claude does not', async t => {
  for (const [runtime, resent] of [['codex', true], ['claude', false]]) {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    await f.put('old/AGENTS.md', 'OLD rules\n')
    const file = await f.put('old/file.txt', 'data\n')
    await f.read(file)
    f.tick(4 * HOUR + 1)
    const again = await f.read(file)
    if (resent) assert.match(f.context(again), /OLD rules/)
    else quiet(again)
  }
})

const ADAPTER_PAYLOADS = {
  claude: base => ({ tool_name: 'Write', tool_input: { file_path: join(base, 'home/other/x.txt'), content: 'x' } }),
  codex: () => ({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: home/other/x.txt\n+x\n*** End Patch' } }),
}

for (const runtime of ['claude', 'codex']) {
  test(`${runtime} adapter bounces with exit code 2, honors --log-only, and fails open on bad input`, async t => {
    const base = await realpath(await mkdtemp(join(homedir(), '.agents-chain-adapter.')))
    t.after(() => rm(base, { recursive: true, force: true }))
    await mkdir(join(base, 'home/other'), { recursive: true })
    await writeFile(join(base, 'home/other/AGENTS.md'), 'ADAPTER rules\n')
    const adapter = fileURLToPath(new URL(`../hooks/${runtime}.mjs`, import.meta.url))
    const env = { ...process.env, XDG_STATE_HOME: join(base, 'state') }
    delete env.AGENTS_CHAIN_MODE
    delete env.AGENTS_CHAIN_DISABLE
    const payload = session => JSON.stringify({ session_id: session, hook_event_name: 'PreToolUse', cwd: base, tool_use_id: 'tu', ...ADAPTER_PAYLOADS[runtime](base) })
    const run = (input, args = []) => spawnSync(process.execPath, [adapter, ...args], { input, env, encoding: 'utf8' })
    const logged = run(payload('log-session'), ['--log-only'])
    assert.equal(logged.status, 0)
    assert.equal(logged.stdout + logged.stderr, '')
    const bounced = run(payload('live-session'))
    assert.equal(bounced.status, 2)
    assert.match(bounced.stderr, /ADAPTER rules/)
    assert.equal(run(payload('live-session')).status, 0, 'an identical retry inside the window passes')
    const bad = run('{not json')
    assert.equal(bad.status, 0)
    assert.equal(bad.stdout + bad.stderr, '')
    const huge = run('x'.repeat(1024 * 1024 + 10))
    assert.equal(huge.status, 0)
    assert.equal(huge.stdout + huge.stderr, '')
    const log = await readFile(join(base, 'state/agents-chain/log.jsonl'), 'utf8')
    assert.match(log, /"error":"INPUT_LIMIT"/)
    const limited = log.trim().split('\n').map(JSON.parse).find(entry => entry.error === 'INPUT_LIMIT')
    assert.deepEqual(limited.reasons, {})
    assert.deepEqual(limited.capped, [])
    assert.equal(limited.epochBytes, 0)
    assert.equal(limited.schema, 2)
  })
}

for (const runtime of ['claude', 'codex']) {
  test(`${runtime}: a lock left by a dead process is broken quickly, and a held lock fails open fast`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    const [state] = await f.sessionFiles()
    const lock = join(dirname(state), 'state.lock')
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'dead', at: Date.now() }), { mode: 0o600 })
    await f.put('lk/AGENTS.md', 'LK rules\n')
    const file = await f.put('lk/file.txt', 'data\n')
    let started = Date.now()
    assert.match(f.context(await f.read(file)), /LK rules/)
    assert.ok(Date.now() - started < 1500, 'dead-owner lock must not wait out the timeout')
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'live', at: Date.now() }), { mode: 0o600 })
    await f.put('lk2/AGENTS.md', 'LK2 rules\n')
    started = Date.now()
    quiet(await f.read(await f.put('lk2/file.txt', 'data\n')))
    assert.ok(Date.now() - started < 3000, 'a held lock fails open within the wait budget')
    assert.ok((await f.logLines()).some(line => line.error === 'LOCK_TIMEOUT'))
  })

  test(`${runtime}: a write in the same batch as a read bounces, and the identical retry passes`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    await f.put('batch/AGENTS.md', 'BATCH rules\n')
    assert.match(f.context(await f.read(await f.put('batch/file.txt', 'data\n'))), /BATCH rules/)
    f.tick(50)
    const target = join(f.base, 'batch/new.txt')
    const bounce = await f.write(target)
    assert.equal(bounce.exitCode, 2)
    assert.match(bounce.stderr, /BATCH rules/)
    f.tick(100)
    quiet(await f.write(target))
  })

  test(`${runtime}: a shell mention of an AGENTS.md delivers it instead of marking it seen`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    const rules = await f.put('ment/AGENTS.md', 'MENT rules\n')
    const grep = await f.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: `grep -c x ${rules}` } })
    assert.match(f.context(grep), /MENT rules/)
  })

  test(`${runtime}: log mode keeps its own state, so live mode still bounces`, async t => {
    const f = await fixture(t, runtime)
    await f.put('mode/AGENTS.md', 'MODE rules\n')
    const target = join(f.base, 'mode/file.txt')
    quiet(await f.write(target, {}, { AGENTS_CHAIN_MODE: 'log' }))
    f.tick(5000)
    assert.equal((await f.write(target)).exitCode, 2)
  })

  test(`${runtime}: quiet calls leave the state file untouched`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    await f.put('q/AGENTS.md', 'Q rules\n')
    const file = await f.put('q/file.txt', 'data\n')
    await f.read(file)
    const [state] = await f.sessionFiles()
    const before = (await stat(state)).mtimeMs
    await new Promise(resolve => setTimeout(resolve, 20))
    quiet(await f.read(file))
    assert.equal((await stat(state)).mtimeMs, before)
  })
}

test('claude: a changed file that does not fit is noted, and later writes never bounce for it', async t => {
  const f = await fixture(t, 'claude')
  await f.hook('SessionStart', { source: 'startup' })
  const rules = await f.put('grow/AGENTS.md', 'G'.repeat(12000))
  const file = await f.put('grow/file.txt', 'data\n')
  await f.read(file)
  assert.equal((await f.write(file)).exitCode, 2)
  f.tick(5000)
  await writeFile(rules, 'H'.repeat(12000))
  assert.match(f.context(await f.read(file)), /changed after it was delivered/)
  f.tick(5000)
  quiet(await f.write(join(f.base, 'grow/other.txt')))
})

test('claude: the agent editing its own AGENTS.md is not re-sent or bounced afterwards', async t => {
  const f = await fixture(t, 'claude')
  await f.hook('SessionStart', { source: 'startup' })
  const rules = await f.put('own/AGENTS.md', 'OWN v1\n')
  quiet(await f.hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: rules } }))
  quiet(await f.hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: rules, old_string: 'v1', new_string: 'v2' } }))
  await writeFile(rules, 'OWN v2\n')
  f.tick(5000)
  quiet(await f.read(await f.put('own/file.txt', 'data\n')))
  quiet(await f.hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: rules, content: 'OWN v3\n' } }))
  await writeFile(rules, 'OWN v3\n')
  f.tick(5000)
  quiet(await f.write(join(f.base, 'own/new.txt')))
})

test('claude: compact reseeds native files from the starting directory, not the current one', async t => {
  const f = await fixture(t, 'claude')
  await f.hook('SessionStart', { source: 'startup' })
  await f.put('else/AGENTS.md', 'ELSE rules\n')
  // Seeded from the current directory, ELSE would count as native and never be delivered
  assert.match(f.context(await f.hook('SessionStart', { source: 'compact', cwd: join(f.base, 'else') })), /ELSE rules/)
  quiet(await f.read(await f.put('else/file.txt', 'data\n')))
})

test('claude: a subagent seeds native files from the main session start', async t => {
  const f = await fixture(t, 'claude')
  await f.hook('SessionStart', { source: 'startup' })
  await mkdir(join(f.base, 'elsewhere'))
  const inProject = await f.put('outer/proj/file.txt', 'data\n')
  quiet(await f.read(inProject, { agent_id: 'agent-2', cwd: join(f.base, 'elsewhere') }))
})

const twinNote = (f, twin, path) => `Same content as ${join(f.base, twin)}, already in context: ${join(f.base, path)} applies under ${dirname(join(f.base, path))}.`

for (const runtime of ['claude', 'codex']) {
  test(`${runtime}: identical content in a sibling directory is referenced, not repeated, and never bounces`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    const first = await f.put('sib/a/file.txt', 'data\n')
    await f.put('sib/a/AGENTS.md', 'SIB rules\n')
    const second = await f.put('sib/b/file.txt', 'data\n')
    await f.put('sib/b/AGENTS.md', 'SIB rules\n')
    assert.match(f.context(await f.read(first)), /SIB rules/)
    const read = await f.read(second)
    assert.equal(read.exitCode, 0)
    assert.equal(f.context(read).includes('SIB rules'), false)
    assert.ok(f.context(read).includes(twinNote(f, 'sib/a/AGENTS.md', 'sib/b/AGENTS.md')))
    quiet(await f.read(second))
    f.tick(5000)
    await f.put('sib/c/AGENTS.md', 'SIB rules\n')
    const write = await f.write(join(f.base, 'sib/c/new.txt'))
    assert.equal(write.exitCode, 0, 'a write under a covered directory is not bounced')
    assert.ok(f.context(write).includes(twinNote(f, 'sib/a/AGENTS.md', 'sib/c/AGENTS.md')))
    quiet(await f.write(join(f.base, 'sib/c/other.txt')))
  })

  test(`${runtime}: a file identical to a natively loaded one is referenced`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    await f.put('twin/AGENTS.md', 'PROJ rules\n')
    const read = f.context(await f.read(await f.put('twin/file.txt', 'data\n')))
    assert.ok(read.includes(twinNote(f, 'outer/proj/AGENTS.md', 'twin/AGENTS.md')))
    assert.equal(read.includes('PROJ rules'), false)
  })

  test(`${runtime}: a bounce carries unique files in full and covered files as notes`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    await f.put('mix/a/AGENTS.md', 'MIX rules\n')
    await f.read(await f.put('mix/a/file.txt', 'data\n'))
    await f.put('mix/b/AGENTS.md', 'MIX rules\n')
    const from = await f.put('mix/b/file.txt', 'data\n')
    await f.put('mix/c/AGENTS.md', 'UNIQUE rules\n')
    await mkdir(join(f.base, 'mix/c'), { recursive: true })
    const bounce = await f.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: `cp ${from} ${join(f.base, 'mix/c/new.txt')}` } })
    assert.equal(bounce.exitCode, 2)
    assert.match(bounce.stderr, /UNIQUE rules/)
    assert.equal(bounce.stderr.includes('MIX rules'), false)
    assert.ok(bounce.stderr.includes(twinNote(f, 'mix/a/AGENTS.md', 'mix/b/AGENTS.md')))
    assert.ok(bounce.stderr.endsWith(RETRY))
  })

  test(`${runtime}: a covered file that later changes is delivered in full`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    await f.put('chg2/a/AGENTS.md', 'SAME rules\n')
    await f.read(await f.put('chg2/a/file.txt', 'data\n'))
    const rules = await f.put('chg2/b/AGENTS.md', 'SAME rules\n')
    const file = await f.put('chg2/b/file.txt', 'data\n')
    assert.ok(f.context(await f.read(file)).includes('Same content as'))
    await writeFile(rules, 'DIFFERENT rules\n')
    assert.match(f.context(await f.read(file)), /DIFFERENT rules/)
  })

  test(`${runtime}: logs record the SessionStart source and covered files`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' })
    await f.hook('SessionStart', { source: 'compact' })
    await f.hook('SessionStart', { source: 'not a valid token!' })
    await f.hook('SessionStart', {})
    await f.put('src/a/AGENTS.md', 'SRC rules\n')
    await f.read(await f.put('src/a/file.txt', 'data\n'))
    await f.put('src/b/AGENTS.md', 'SRC rules\n')
    await f.read(await f.put('src/b/file.txt', 'data\n'), { tool_use_id: 'tu-cov' })
    const lines = await f.logLines()
    assert.deepEqual(lines.filter(line => line.event === 'SessionStart').map(line => line.source), ['startup', 'compact', 'other', null])
    assert.ok(lines.filter(line => line.event === 'PreToolUse').every(line => line.source === null))
    assert.deepEqual(lines.find(line => line.toolUseId === 'tu-cov').covered, [join(f.base, 'src/b/AGENTS.md')])
    assert.doesNotMatch(await readFile(join(f.root, 'log.jsonl'), 'utf8'), /SRC rules/)
  })
}

for (const runtime of ['claude', 'codex']) {
  test(`${runtime}: the epoch counts final bytes, caps later files, and resets with history`, async t => {
    const options = { epochBytesCap: 1000 }
    const f = await fixture(t, runtime, options)
    await f.hook('SessionStart', { source: 'startup' })
    const rules = await f.put('cap/AGENTS.md', '# Cap topic\n' + 'private body '.repeat(25))
    const file = await f.put('cap/file.txt', 'x')
    const first = f.context(await f.read(file))
    let lines = await f.logLines()
    assert.equal(lines.at(-1).epochBytes, lines.reduce((sum, line) => sum + line.bytes, 0))
    assert.equal(lines.at(-1).bytes, Buffer.byteLength(first))
    assert.equal(lines.at(-1).reasons[rules], 'new')
    options.epochBytesCap = lines.at(-1).epochBytes
    const secondRules = await f.put('cap2/AGENTS.md', '# Second topic\nSECRET BODY')
    const secondFile = await f.put('cap2/file.txt', 'x')
    const second = f.context(await f.read(secondFile))
    assert.match(second, /# Second topic/)
    assert.doesNotMatch(second, /SECRET BODY/)
    lines = await f.logLines()
    assert.deepEqual(lines.at(-1).capped, [secondRules])
    const [path] = await f.sessionFiles()
    assert.equal(JSON.parse(await readFile(path, 'utf8')).files[secondRules].outline, true)
    quiet(await f.read(secondFile))
    const epoch = (await f.logLines()).at(-1).epochBytes
    await f.hook('SessionStart', { source: 'resume' })
    assert.equal((await f.logLines()).at(-1).epochBytes, epoch)
    options.epochBytesCap = 2000
    await f.hook('SessionStart', { source: 'compact' })
    const reset = (await f.logLines()).at(-1)
    assert.equal(reset.epochBytes, reset.bytes)
    await f.hook('SessionStart', { source: 'compact' })
    assert.match(f.context(await f.read(file)), /private body/)
    assert.equal((await f.logLines()).at(-1).reasons[rules], 'after-reset')
    const fresh = await f.put('cap3/AGENTS.md', '# New topic')
    await f.read(await f.put('cap3/file.txt', 'x'))
    assert.equal((await f.logLines()).at(-1).reasons[fresh], 'new')
  })

  test(`${runtime}: capped writes bounce once and outlines cannot cover full twins`, async t => {
    const f = await fixture(t, runtime, { epochBytesCap: 0 })
    await f.hook('SessionStart', { source: 'startup' })
    const rules = '# Topic\nHIDDEN full text'
    await f.put('out/a/AGENTS.md', rules)
    const target = join(f.base, 'out/a/new.txt')
    const bounce = await f.write(target)
    assert.equal(bounce.exitCode, 2)
    assert.match(bounce.stderr, /# Topic/)
    assert.doesNotMatch(bounce.stderr, /HIDDEN full text/)
    assert.ok(bounce.stderr.endsWith(RETRY))
    quiet(await f.write(target))
    await f.put('out/b/AGENTS.md', rules)
    const other = await f.write(join(f.base, 'out/b/new.txt'))
    assert.equal(other.exitCode, 2, 'an outline is not a full-content twin')
    assert.doesNotMatch(other.stderr, /Same content as/)
    await f.put('out/a/AGENTS.md', '# Changed\nNEW hidden body')
    const changed = f.context(await f.read(target))
    assert.match(changed, /# Changed/)
    assert.equal((await f.logLines()).at(-1).reasons[join(f.base, 'out/a/AGENTS.md')], 'changed')
  })

  test(`${runtime}: log-only applies the cap in its own namespace`, async t => {
    const f = await fixture(t, runtime, { epochBytesCap: 0 })
    const rules = await f.put('caplog/AGENTS.md', '# Log topic\nPRIVATE body')
    quiet(await f.write(join(f.base, 'caplog/new.txt'), {}, { AGENTS_CHAIN_MODE: 'log' }))
    const line = (await f.logLines()).at(-1)
    assert.deepEqual(line.capped, [rules])
    assert.equal(line.reasons[rules], 'new')
    assert.ok(line.epochBytes > 0)
    assert.equal((await f.write(join(f.base, 'caplog/new.txt'))).exitCode, 2)
  })
}

test('legacy state gains zero accounting, while invalid counters fail open', async t => {
  const f = await fixture(t, 'codex')
  await f.hook('SessionStart', { source: 'startup' })
  const [path] = await f.sessionFiles()
  const state = JSON.parse(await readFile(path, 'utf8'))
  delete state.epochBytes
  delete state.priorEpoch
  await writeFile(path, JSON.stringify(state))
  await f.put('legacy/AGENTS.md', '# Legacy\nrules')
  const file = await f.put('legacy/file.txt', 'x')
  const text = f.context(await f.read(file))
  assert.equal((await f.logLines()).at(-1).epochBytes, Buffer.byteLength(text))
  const bad = JSON.parse(await readFile(path, 'utf8'))
  bad.epochBytes = 'bad'
  await writeFile(path, JSON.stringify(bad))
  quiet(await f.write(join(f.base, 'bad/new.txt')))
  assert.equal((await f.logLines()).at(-1).error, 'STATE_INVALID')
})

test('reasons follow changed, recent, noted and stale classifications', async t => {
  const f = await fixture(t, 'codex')
  await f.hook('SessionStart', { source: 'startup' })
  const rules = await f.put('why/AGENTS.md', '# Why\noriginal')
  const file = await f.put('why/file.txt', 'x')
  await f.read(file)
  await f.write(join(f.base, 'why/other.txt'))
  assert.equal((await f.logLines()).at(-1).reasons[rules], 'recent')
  f.tick(5000)
  await writeFile(rules, '# Why\nchanged')
  await f.read(file)
  assert.equal((await f.logLines()).at(-1).reasons[rules], 'changed')
  f.tick(4 * HOUR + 1)
  await f.read(file)
  assert.equal((await f.logLines()).at(-1).reasons[rules], 'stale')
  const c = await fixture(t, 'claude')
  await c.hook('SessionStart', { source: 'startup' })
  const large = await c.put('why/AGENTS.md', 'L'.repeat(12000))
  const largeFile = await c.put('why/file.txt', 'x')
  await c.read(largeFile)
  await c.write(largeFile)
  assert.equal((await c.logLines()).at(-1).reasons[large], 'noted')
})

for (const runtime of ['claude', 'codex']) {
  test(`${runtime}: telemetry records bounce retry latency, age, dedupe savings and version`, async t => {
    const f = await fixture(t, runtime)
    await f.hook('SessionStart', { source: 'startup' }, { CODEX_VERSION: '0.163.0' })
    await f.put('tele/a/AGENTS.md', 'TELE rules\n')
    const target = join(f.base, 'tele/a/new.txt')
    await f.write(target)
    let line = (await f.logLines()).at(-1)
    assert.match(line.callHash, /^[a-f0-9]{16}$/)
    assert.equal(typeof line.ver, 'number')
    assert.equal(line.schema, 2)
    assert.ok(Number.isInteger(line.lockWaitMs) && line.lockWaitMs >= 0)
    f.tick(123)
    quiet(await f.write(target))
    assert.equal((await f.logLines()).at(-1).retryOfMs, 123)
    f.tick(2 * 60 * 1000)
    quiet(await f.read(target))
    assert.equal((await f.logLines()).at(-1).ageMin, 2)
    f.tick(4 * HOUR)
    await f.read(target)
    assert.equal((await f.logLines()).at(-1).ageMin, 242)
    await f.put('tele/b/AGENTS.md', 'TELE rules\n')
    await f.read(await f.put('tele/b/file.txt', 'x'))
    assert.equal((await f.logLines()).at(-1).savedBytes, 11)
    const start = (await f.logLines())[0]
    if (runtime === 'codex') assert.equal(start.runtimeVersion, '0.163.0')
    else assert.equal(start.runtimeVersion, undefined)
  })
}

test('Codex native overflow and shell parse misses are measured without logging tokens', async t => {
  const f = await fixture(t, 'codex')
  await f.put('outer/proj/AGENTS.md', 'R'.repeat(20000))
  const deeper = await f.put('outer/proj/deep/AGENTS.md', 'D'.repeat(20000))
  await f.hook('SessionStart', { source: 'startup', cwd: join(f.cwd, 'deep') })
  const start = (await f.logLines()).at(-1)
  assert.equal(start.nativeBytes, 40000)
  assert.deepEqual(start.nativeOverflow, [deeper])
  await f.hook('PreToolUse', { tool_name: 'exec_command', tool_input: { cmd: 'cat "$UNRESOLVED_PRIVATE/path" "*.missing"' } })
  const miss = (await f.logLines()).at(-1)
  assert.equal(miss.decision, 'none')
  assert.equal(miss.candidates, 0)
  assert.equal(miss.unresolved, 2)
  assert.doesNotMatch(await readFile(join(f.root, 'log.jsonl'), 'utf8'), /UNRESOLVED_PRIVATE|missing/)
})

test('instrumentation failure and disabling telemetry leave decisions and output identical', async t => {
  const options = { instrumentation: false }
  const f = await fixture(t, 'claude', options)
  await f.put('inv/AGENTS.md', '# Invariance\nrules')
  const target = join(f.base, 'inv/new.txt')
  const run = id => f.write(target, { session_id: id })
  const plain = await run('plain')
  delete options.instrumentation
  assert.deepEqual(await run('observed'), plain)
  options.instrumentation = () => { throw new Error('PRIVATE instrumentation detail') }
  assert.deepEqual(await run('broken'), plain)
  const line = (await f.logLines()).at(-1)
  assert.equal(line.instrumentError, 'COLLECT')
  assert.equal(line.decision, 'bounce')
  assert.equal(line.error, undefined)
  assert.equal(line.ageMin, undefined)
  assert.doesNotMatch(await readFile(join(f.root, 'log.jsonl'), 'utf8'), /PRIVATE instrumentation detail/)
})

test('lock contention and deadline failures expose operational diagnostics', async t => {
  const options = {}
  const f = await fixture(t, 'claude', options)
  await f.hook('SessionStart', { source: 'startup' })
  const [path] = await f.sessionFiles()
  const lock = join(dirname(path), 'state.lock')
  const file = await f.put('outer/proj/file.txt', 'x')
  await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'held', at: Date.now() }))
  const release = setTimeout(() => rm(lock, { force: true }), 300)
  t.after(() => clearTimeout(release))
  await f.read(file)
  assert.ok((await f.logLines()).at(-1).lockWaitMs >= 20)
  options.deadlineMs = -1
  quiet(await f.write(join(f.base, 'outer/proj/next.txt')))
  const line = (await f.logLines()).at(-1)
  assert.equal(line.error, 'DEADLINE')
  assert.equal(line.deadlineHit, true)
})

test('instrumentation replay preserves context, capped bounces, retries, quiet calls and resets', async t => {
  const options = { instrumentation: false, epochBytesCap: 500 }
  const f = await fixture(t, 'claude', options)
  await f.put('replay/AGENTS.md', '# Replay\n' + 'body '.repeat(100))
  const file = await f.put('replay/file.txt', 'x')
  const replay = async session_id => {
    const steps = [
      ['SessionStart', { source: 'startup' }],
      ['PreToolUse', { tool_name: 'Read', tool_input: { file_path: file } }],
      ['PreToolUse', { tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }],
      ['PreToolUse', { tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }],
      ['PreToolUse', { tool_name: 'Read', tool_input: { file_path: file } }],
      ['SessionStart', { source: 'compact' }],
    ]
    const results = []
    for (const [event, fields] of steps) results.push(await f.hook(event, { ...fields, session_id }))
    return results
  }
  const plain = await replay('plain-replay')
  delete options.instrumentation
  assert.deepEqual(await replay('instrumented-replay'), plain)
})

test('log-only bounces do not claim retries and logs retain a larger single rotation', async t => {
  const f = await fixture(t, 'claude')
  const env = { AGENTS_CHAIN_MODE: 'log' }
  await f.put('rotation/AGENTS.md', '# Rotation')
  const file = join(f.base, 'rotation/new.txt')
  await f.write(file, {}, env)
  f.tick(100)
  await f.write(file, {}, env)
  assert.equal((await f.logLines()).at(-1).retryOfMs, undefined)
  const log = join(f.root, 'log.jsonl')
  await writeFile(log, ' '.repeat(6 * 1024 * 1024))
  await f.write(file, {}, env)
  assert.equal(existsSync(`${log}.1`), false)
  await writeFile(log, ' '.repeat(20 * 1024 * 1024 + 1))
  await f.write(file, {}, env)
  assert.equal((await stat(`${log}.1`)).size, 20 * 1024 * 1024 + 1)
  assert.ok((await stat(log)).size < 4096)
})

test('outline metadata that cannot fit remains pending until bounded bounce retries deliver it', async t => {
  const f = await fixture(t, 'claude', { epochBytesCap: 0 })
  await f.hook('SessionStart', { source: 'startup' })
  let rel = 'deep'
  const rules = []
  for (let i = 0; i < 24; i += 1) {
    rel += `/level${i}`
    rules.push(await f.put(`${rel}/AGENTS.md`, `# Topic ${i}\nHidden body ${i}`))
  }
  const target = join(f.base, rel, 'new.txt')
  assert.ok(f.context(await f.read(target)).length <= 9500)
  let attempts = 0
  for (; attempts < 5; attempts += 1) {
    const result = await f.write(target)
    if (result.exitCode === 0) break
    assert.equal(result.exitCode, 2)
    assert.ok(result.stderr.length <= 40000, result.stderr.length)
    assert.ok(result.stderr.endsWith(RETRY))
  }
  assert.ok(attempts > 0 && attempts < 5)
  const [path] = await f.sessionFiles()
  const state = JSON.parse(await readFile(path, 'utf8'))
  assert.ok(rules.every(path => state.files[path]?.delivered))
})
