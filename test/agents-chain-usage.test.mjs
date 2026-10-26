import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SENSITIVE = join(tmpdir(), 'agents-chain-sensitive')
const cli = fileURLToPath(new URL('../agents-chain-report', import.meta.url))
const at = minute => `2026-10-26T00:${String(minute).padStart(2, '0')}:00Z`
const meta = { type: 'session_meta', timestamp: at(0), payload: { id: 'private-session', timestamp: at(0) } }
const snapshot = (minute, input, output, extras = {}) => ({ type: 'event_msg', timestamp: at(minute), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: input / 2, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: output / 2, total_tokens: input + output, ...extras } } } })
const claude = (minute, id, usage) => ({ type: 'assistant', timestamp: at(minute), sessionId: 'private-claude-session', requestId: id, message: { id: `message-${id}`, model: 'claude-test-model', usage, content: [{ type: 'text', text: 'PRIVATE PROMPT CONTENT' }] } })

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agents-chain-usage.'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const put = async (name, records) => {
    const file = join(dir, name)
    await writeFile(file, records.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n')
    return file
  }
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: dir, AGENTS_CHAIN_EXCLUDED_ROOTS: JSON.stringify([SENSITIVE]) } })
  return { dir, put, run }
}

test('CLI exposes optional transcript usage and never sums cumulative Codex snapshots', async t => {
  const f = await fixture(t)
  const file = await f.put('codex.jsonl', [meta, snapshot(1, 100, 20), snapshot(1, 100, 20), snapshot(2, 140, 30)])
  const before = await readFile(file, 'utf8')
  const result = f.run(['--json', '-u', file])
  assert.equal(result.status, 0, result.stderr)
  const usage = JSON.parse(result.stdout).runtimeUsage
  assert.equal(usage.coverage.filesRead, 1)
  assert.equal(usage.sessions.length, 1)
  const session = usage.sessions[0]
  assert.equal(session.runtime, 'codex')
  assert.equal(session.inputTokens, 140)
  assert.equal(session.cachedInputTokens, 70)
  assert.equal(session.outputTokens, 30)
  assert.equal(session.totalTokens, 170)
  assert.equal(session.reasoningOutputTokens, 15)
  assert.doesNotMatch(result.stdout, /private-session/)
  assert.equal(await readFile(file, 'utf8'), before)
})

test('Claude streaming updates deduplicate requests and normalize exclusive cache counters', async t => {
  const f = await fixture(t)
  const base = { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 3 }
  const file = await f.put('claude.jsonl', [claude(1, 'one', base), claude(1, 'one', { ...base, output_tokens: 5 }), claude(2, 'two', { input_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 30, output_tokens: 7 })])
  const result = f.run(['--json', `--usage-file=${file}`, '-u', file])
  assert.equal(result.status, 0, result.stderr)
  const usage = JSON.parse(result.stdout).runtimeUsage
  assert.equal(usage.sessions.length, 1)
  assert.equal(usage.coverage.duplicateFiles, 1)
  const session = usage.sessions[0]
  assert.equal(session.requests, 2)
  assert.equal(session.inputTokens, 66)
  assert.equal(session.cachedInputTokens, 50)
  assert.equal(session.cacheWriteInputTokens, 10)
  assert.equal(session.outputTokens, 12)
  assert.equal(session.totalTokens, 78)
  assert.equal(session.reasoningOutputTokens, null)
  assert.deepEqual(session.models, ['claude-test-model'])
  assert.doesNotMatch(result.stdout, /PRIVATE PROMPT CONTENT|private-claude-session/)
})

test('since subtracts the preceding Codex snapshot and does not count earlier Claude requests', async t => {
  const f = await fixture(t)
  const codex = await f.put('codex.jsonl', [meta, snapshot(1, 100, 20), snapshot(3, 160, 40)])
  const native = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 }
  const anthropic = await f.put('claude.jsonl', [claude(1, 'one', native), claude(3, 'two', native)])
  const result = f.run(['--json', '-u', codex, '-u', anthropic, '-s', at(2)])
  assert.equal(result.status, 0, result.stderr)
  const sessions = JSON.parse(result.stdout).runtimeUsage.sessions
  assert.equal(sessions.find(s => s.runtime === 'codex').inputTokens, 60)
  assert.equal(sessions.find(s => s.runtime === 'codex').outputTokens, 20)
  assert.equal(sessions.find(s => s.runtime === 'claude').requests, 1)
})

test('missing baselines, counter resets and absent counters stay explicitly unknown', async t => {
  const f = await fixture(t)
  const file = await f.put('codex.jsonl', [meta, snapshot(3, 100, 20)])
  const result = f.run(['--json', '-u', file, '-s', at(2)])
  assert.equal(result.status, 0, result.stderr)
  const session = JSON.parse(result.stdout).runtimeUsage.sessions[0]
  assert.equal(session.inputTokens, null)
  assert.ok(session.issues.includes('MISSING_BASELINE'))
  await writeFile(file, [meta, snapshot(1, 100, 20), snapshot(2, 50, 10)].map(r => JSON.stringify(r)).join('\n'))
  const reset = JSON.parse(f.run(['--json', '-u', file]).stdout).runtimeUsage.sessions[0]
  assert.equal(reset.inputTokens, null)
  assert.ok(reset.issues.includes('COUNTER_RESET'))
})

test('unavailable, malformed and unsupported sources cannot fail the hook report or disclose contents', async t => {
  const f = await fixture(t)
  const malformed = await f.put('bad.jsonl', ['PRIVATE BROKEN RECORD', { unrelated: 'PRIVATE VALUE' }])
  const result = f.run(['--json', '-u', malformed, '-u', join(f.dir, 'missing')])
  assert.equal(result.status, 0, result.stderr)
  const usage = JSON.parse(result.stdout).runtimeUsage
  assert.equal(usage.coverage.malformed, 1)
  assert.equal(usage.coverage.unavailableFiles, 1)
  assert.equal(usage.coverage.unsupportedFiles, 1)
  assert.deepEqual(usage.sessions, [])
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE/)
})

test('credential paths and symlinks to them are rejected before reading', async t => {
  const f = await fixture(t)
  const link = join(f.dir, 'secret-link')
  await symlink(join(SENSITIVE, 'credentials'), link)
  const result = f.run(['--json', '-u', join(SENSITIVE, 'credentials'), '-u', join(SENSITIVE, 'credentials'), '-u', link])
  assert.equal(result.status, 0, result.stderr)
  const usage = JSON.parse(result.stdout).runtimeUsage
  assert.equal(usage.coverage.unavailableFiles, 3)
  assert.ok(usage.sources.every(s => s.error === 'SENSITIVE_PATH'))
})

test('overflowing usage totals cannot fail the main report and missing cache counters stay unknown', async t => {
  const f = await fixture(t)
  const file = await f.put('overflow.jsonl', [
    claude(1, 'one', { input_tokens: Number.MAX_SAFE_INTEGER - 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }),
    claude(2, 'two', { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }),
  ])
  const result = f.run(['--json', '-u', file])
  assert.equal(result.status, 0, result.stderr)
  const session = JSON.parse(result.stdout).runtimeUsage.sessions[0]
  assert.equal(session.inputTokens, null)
  assert.ok(session.issues.includes('INVALID_COUNTER'))
  const missing = await f.put('missing-cache.jsonl', [claude(1, 'one', { input_tokens: 5, output_tokens: 2 })])
  const partial = JSON.parse(f.run(['--json', '-u', missing]).stdout).runtimeUsage.sessions[0]
  assert.equal(partial.inputTokens, null)
  assert.equal(partial.cachedInputTokens, null)
  assert.equal(partial.outputTokens, 2)
  assert.equal(partial.status, 'partial')
})

test('usage option supports short bundles and reports invalid values on stderr', async t => {
  const f = await fixture(t)
  const file = await f.put('usage.jsonl', [meta, snapshot(1, 100, 20)])
  for (const args of [[`-u${file}`, '--json'], ['-hu', file], ['--json', '-u', file, '--']]) {
    const result = f.run(args)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
  }
  for (const args of [['--usage-file'], ['--usage-file='], ['-u'], ['-u', '']]) {
    const result = f.run(args)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /agents-chain-report:/)
  }
  assert.match(f.run(['--help']).stdout, /--usage-file/)
  assert.match(f.run(['-u', file]).stdout, /Runtime usage/)
})

test('missing-counter snapshots cannot hide a later cumulative counter reset', async t => {
  const f = await fixture(t)
  const gap = snapshot(2, 100, 20)
  gap.payload.info.total_token_usage = {}
  const file = await f.put('gap.jsonl', [meta, snapshot(1, 100, 20), gap, snapshot(3, 50, 10)])
  const result = f.run(['--json', '-u', file])
  assert.equal(result.status, 0, result.stderr)
  const session = JSON.parse(result.stdout).runtimeUsage.sessions[0]
  assert.equal(session.inputTokens, null)
  assert.ok(session.issues.includes('COUNTER_RESET'))
})

test('usage with unknown timestamps remains visible as unknown when filtering', async t => {
  const f = await fixture(t)
  const codex = snapshot(1, 100, 20)
  delete codex.timestamp
  const anthropic = claude(1, 'one', { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 })
  delete anthropic.timestamp
  const file = await f.put('unknown-time.jsonl', [meta, codex, anthropic])
  const result = f.run(['--json', '-u', file, '-s', at(2)])
  assert.equal(result.status, 0, result.stderr)
  const sessions = JSON.parse(result.stdout).runtimeUsage.sessions
  assert.equal(sessions.length, 2)
  assert.ok(sessions.every(s => s.inputTokens === null && s.issues.includes('MISSING_TIMESTAMP')))
})

test('overlapping Claude sources give the same filtered usage in either input order', async t => {
  const f = await fixture(t)
  const usage = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 }
  const before = await f.put('before.jsonl', [claude(1, 'one', usage)])
  const after = await f.put('after.jsonl', [claude(3, 'one', usage)])
  for (const [first, second] of [[before, after], [after, before]]) {
    const result = f.run(['--json', '-u', first, '-u', second, '-s', at(2)])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).runtimeUsage.sessions, [])
  }
})

test('a request without identifiers makes its known session incomplete', async t => {
  const f = await fixture(t)
  const usage = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 }
  const unidentified = claude(2, 'two', usage)
  delete unidentified.requestId
  delete unidentified.message.id
  const file = await f.put('unidentified.jsonl', [claude(1, 'one', usage), unidentified])
  const result = f.run(['--json', '-u', file])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout).runtimeUsage
  assert.equal(report.coverage.invalidUsage, 1)
  assert.equal(report.sessions[0].status, 'partial')
  assert.ok(report.sessions[0].issues.includes('MISSING_USAGE_ID'))
  assert.equal(report.sessions[0].inputTokens, null)
})

test('configured sensitive-directory aliases protect the canonical usage source', async t => {
  const f = await fixture(t)
  const sensitive = join(f.dir, 'sensitive')
  await mkdir(sensitive)
  const alias = join(f.dir, 'alias')
  await symlink(sensitive, alias)
  const file = await f.put('sensitive/usage.jsonl', [meta, snapshot(1, 100, 20)])
  for (const excluded of [alias, '/']) {
    const result = spawnSync(process.execPath, [cli, '--json', '-u', file], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: f.dir, AGENTS_CHAIN_EXCLUDED_ROOTS: JSON.stringify([excluded]) } })
    assert.equal(result.status, 0, result.stderr)
    const usage = JSON.parse(result.stdout).runtimeUsage
    assert.equal(usage.coverage.unavailableFiles, 1)
    assert.equal(usage.sources[0].error, 'SENSITIVE_PATH')
    assert.deepEqual(usage.sessions, [])
  }
})
