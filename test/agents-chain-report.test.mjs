import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../agents-chain-report', import.meta.url))
const row = (minute, fields = {}) => ({ ts: `2026-10-23T00:${String(minute).padStart(2, '0')}:00.000Z`, runtime: 'codex', session: 's1', agent: null, mode: 'log', event: 'PreToolUse', source: null, decision: 'none', bytes: 0, ...fields })

test('token report estimates legacy bytes and preserves unknown attribution', async t => {
  const f = await fixture(t)
  const report = JSON.parse(f.run(['--json', '-f', f.log]).stdout)
  const group = report.groups.find(g => g.runtime === 'codex' && g.mode === 'log')
  assert.ok(group.tokens)
  assert.equal(group.tokens.estimate, 182.5)
  assert.equal(group.tokens.method, 'utf8-bytes/4')
  assert.deepEqual(group.tokens.perDelivery, { samples: 6, median: 21.25, p95: 75, max: 75 })
  assert.deepEqual(group.tokens.perEpoch, { samples: 3, median: 40, p95: 125, max: 125 })
  assert.deepEqual(group.tokens.perSession, { samples: 1, median: 182.5, p95: 182.5, max: 182.5 })
  assert.equal(group.tokens.attributedCalls, 0)
  assert.equal(group.tokens.unattributedBytes, 730)
})

test('token report sums only valid attribution and ranks contributing files', async t => {
  const f = await fixture(t)
  await writeFile(f.log, [
    row(0, { decision: 'context', bytes: 100, tokens: { method: 'utf8-bytes/4', estimate: 25, parts: [{ path: '/a', kind: 'full', reason: 'new', bytes: 60 }, { path: null, kind: 'wrapper', reason: 'wrapper', bytes: 40 }] } }),
    row(1, { decision: 'context', bytes: 80, tokens: { method: 'utf8-bytes/4', estimate: 20, parts: [{ path: '/a', kind: 'outline', reason: 'after-reset', bytes: 40 }, { path: '/b', kind: 'covered', reason: 'covered', bytes: 20 }, { path: null, kind: 'wrapper', reason: 'wrapper', bytes: 20 }] } }),
    row(2, { bytes: 40, decision: 'context', tokens: { method: 'unknown', estimate: 10, parts: [{ path: '/bad', kind: 'full', reason: 'new', bytes: 40 }] } }),
  ].map(e => JSON.stringify(e)).join('\n'))
  const report = JSON.parse(f.run(['--json', '-f', f.log]).stdout)
  const tokens = report.groups[0].tokens
  assert.equal(tokens.estimate, 55)
  assert.equal(tokens.attributedCalls, 2)
  assert.equal(tokens.unattributedBytes, 40)
  assert.deepEqual(tokens.byKind, { full: 15, wrapper: 15, outline: 10, covered: 5 })
  assert.deepEqual(tokens.byReason, { new: 15, wrapper: 15, 'after-reset': 10, covered: 5 })
  assert.deepEqual(tokens.topFiles, [{ path: '/a', bytes: 100, estimate: 25 }, { path: '/b', bytes: 20, estimate: 5 }])
})

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agents-chain-report.'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const log = join(dir, 'log.jsonl')
  const entries = [
    row(0, { event: 'SessionStart', source: 'startup', decision: 'context', bytes: 100, reasons: { '/a': 'new' }, epochBytes: 100, capped: [], nativeBytes: 40000, nativeOverflow: ['/n'], ms: 20 }),
    row(1, { decision: 'bounce', bytes: 50, reasons: { '/b': 'new' }, capped: ['/b'], unresolved: 2, excluded: { 'outside-home': 2 }, ms: 30 }),
    row(2, { retryOfMs: 120, ageMin: 5, unresolved: 0, ms: 40 }),
    row(3, { event: 'SessionStart', source: 'resume', bytes: 10, decision: 'context', savedBytes: 80 }),
    row(4, { event: 'SessionStart', source: 'compact', decision: 'context', bytes: 200, reasons: { '/a': 'after-reset' }, capped: [] }),
    row(5, { decision: 'context', bytes: 300, reasons: { '/a': 'stale' }, ageMin: 241 }),
    row(6, { agent: 'child', decision: 'context', bytes: 70 }),
    row(7, { mode: 'live', event: 'SessionStart', source: 'startup', decision: 'bounce', bytes: 10 }),
    row(8, { runtime: 'claude', session: 's2', ageMin: 240, error: 'DEADLINE', deadlineHit: true }),
  ]
  await writeFile(log, entries.map(e => JSON.stringify(e)).join('\n') + '\n{broken\nnull\n')
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: dir } })
  return { dir, log, run }
}

test('report JSON separates modes and agents, resumes epochs and summarizes measured fields', async t => {
  const f = await fixture(t)
  const result = f.run(['--json', '--file', f.log])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.coverage.malformed, 2)
  const group = report.groups.find(g => g.runtime === 'codex' && g.mode === 'log')
  assert.equal(group.sessions, 1)
  assert.equal(group.calls, 7)
  assert.equal(group.deliveries, 6)
  assert.equal(group.bytes, 730)
  assert.equal(group.epochs, 3)
  assert.equal(group.worstEpochs[0].bytes, 500)
  assert.equal(group.worstEpochs[1].bytes, 160)
  assert.equal(group.worstEpochs[2].partialStart, true)
  assert.deepEqual(group.reasons, { new: 2, 'after-reset': 1, stale: 1 })
  assert.equal(group.capped, 1)
  assert.equal(group.bounces, 1)
  assert.deepEqual(group.retries, { samples: 1, median: 120, p95: 120, max: 120 })
  assert.deepEqual(group.sources, { startup: 1, resume: 1, compact: 1 })
  assert.equal(group.ages.under60, 1)
  assert.equal(group.ages.atOrOver240, 1)
  assert.equal(group.native.overflowFiles, 1)
  assert.equal(group.native.bytes, 40000)
  assert.deepEqual(group.excluded, { 'outside-home': 2 })
  assert.deepEqual(group.shell, { measuredCalls: 2, missCalls: 1, unresolved: 2, missRate: 0.5 })
  assert.equal(group.savedBytes, 80)
  assert.equal(group.timings.median, 30)
  assert.equal(report.groups.find(g => g.runtime === 'codex' && g.mode === 'live').bytes, 10)
  const claude = report.groups.find(g => g.runtime === 'claude')
  assert.equal(claude.deadlineHits, 1)
  assert.deepEqual(claude.errors, { DEADLINE: 1 })
  assert.equal(claude.shell.missRate, null, 'old records do not measure parse misses')
})

test('since filters observed bytes and labels truncated epochs', async t => {
  const f = await fixture(t)
  const result = f.run(['--json', `--file=${f.log}`, '-s2026-10-23T00:02:00Z'])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  const group = report.groups.find(g => g.runtime === 'codex' && g.mode === 'log')
  assert.equal(group.calls, 5)
  assert.equal(group.bytes, 580)
  assert.equal(group.worstEpochs.find(e => e.bytes === 10).partialStart, true)
  assert.equal(report.coverage.filtered, 2)
})

test('default report includes both retained generations, tolerates absent logs and never writes', async t => {
  const f = await fixture(t)
  const env = { ...process.env, XDG_STATE_HOME: f.dir }
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env })
  assert.equal(JSON.parse(run(['--json']).stdout).groups.length, 0)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(f.dir, 'agents-chain'))
  const current = join(f.dir, 'agents-chain/log.jsonl')
  await writeFile(`${current}.1`, JSON.stringify(row(0, { bytes: 5, decision: 'context' })) + '\n')
  await writeFile(current, JSON.stringify(row(1, { bytes: 7, decision: 'context' })) + '\n')
  const before = await readFile(current, 'utf8')
  const names = await readdir(join(f.dir, 'agents-chain'))
  const result = run(['--json'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).groups[0].bytes, 12)
  assert.equal(JSON.parse(result.stdout).coverage.filesRead, 2)
  assert.equal(await readFile(current, 'utf8'), before)
  assert.deepEqual(await readdir(join(f.dir, 'agents-chain')), names)
})

test('CLI help, option grammar, usage errors and read failures use the documented streams', async t => {
  const f = await fixture(t)
  for (const args of [['-h'], ['--help'], ['-h', '--json'], ['--help', '--'], ['-hf', f.log]]) {
    const result = f.run(args)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Usage:/)
    assert.equal(result.stderr, '')
  }
  for (const args of [['--json', `-f${f.log}`], ['--json', '-f', f.log, '--'], ['--json', '--since=2026-10-23T00:02:00Z', '-f', f.log]]) {
    const result = f.run(args)
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotThrow(() => JSON.parse(result.stdout))
  }
  for (const args of [['--bogus'], ['--file'], ['--file='], ['--since'], ['--since='], ['-s', 'yesterday'], ['-s', '2026-02-30T00:00:00Z'], ['extra'], ['--', '--json']]) {
    const result = f.run(args)
    assert.equal(result.status, 2, JSON.stringify(args))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /agents-chain-report:/)
  }
  const missing = f.run(['--file', join(f.dir, 'missing')])
  assert.equal(missing.status, 1)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /Unable to read/)
  const human = f.run(['-f', f.log])
  assert.equal(human.status, 0)
  for (const word of ['codex (log)', 'Sessions', 'Worst epochs', 'Reasons', 'Retries', 'Ages', 'Native', 'Exclusions', 'Parse misses', 'partial']) assert.ok(human.stdout.includes(word), word)
})

test('extensionless front door works without automatic module-syntax detection', async t => {
  const { symlink } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  const f = await fixture(t)
  const commonjs = join(f.dir, 'report.cjs')
  await writeFile(commonjs, await readFile(cli))
  await symlink(join(dirname(cli), 'lib'), join(f.dir, 'lib'))
  const result = spawnSync(process.execPath, [commonjs, '--json', '-f', f.log], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).coverage.malformed, 2)
})

test('failed resets preserve epochs and legacy missing sources retain uncertainty', async t => {
  const f = await fixture(t)
  const entries = [
    row(0, { event: 'SessionStart', source: 'startup', decision: 'context', bytes: 100, epochBytes: 100 }),
    row(1, { event: 'SessionStart', source: 'compact', error: 'LOCK_TIMEOUT', epochBytes: 0 }),
    row(2, { decision: 'context', bytes: 100, epochBytes: 200 }),
    row(3, { event: 'SessionStart', source: null, decision: 'context', bytes: 50 }),
  ]
  await writeFile(f.log, entries.map(e => JSON.stringify(e)).join('\n'))
  const result = f.run(['--json', '-f', f.log])
  assert.equal(result.status, 0, result.stderr)
  const group = JSON.parse(result.stdout).groups[0]
  assert.equal(group.epochs, 1)
  assert.equal(group.worstEpochs[0].bytes, 250)
  assert.equal(group.worstEpochs[0].uncertainBoundary, true)
  assert.equal(group.uncertainEpochs, 1)
})
