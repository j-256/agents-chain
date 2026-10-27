import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { toolTargets } from '../lib/agents-chain-tools.mjs'
import { handleAgentsChain } from '../lib/agents-chain.mjs'

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agents-chain-git-scope.')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const put = async (path, content) => {
    const target = join(base, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    return target
  }
  const cwd = join(base, 'project')
  await put('project/AGENTS.md', 'PROJECT rules\n')
  await put('project/data.txt', 'project data\n')
  execFileSync('git', ['init', '-q', cwd])
  const payload = command => ({ cwd, tool_name: 'Bash', tool_input: { command, workdir: cwd } })
  const shell = command => toolTargets(payload(command))
  const root = join(base, 'state')
  const hook = (runtime, event, fields = {}) => handleAgentsChain(runtime, {
    session_id: `git-scope-${runtime}`, cwd, hook_event_name: event, ...fields,
  }, { root, home: join(base, 'home'), trusted: [base], env: {} })
  const call = (runtime, command) => hook(runtime, 'PreToolUse', payload(command))
  const context = result => JSON.parse(result.stdout).hookSpecificOutput.additionalContext
  const log = async () => (await readFile(join(root, 'log.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  return { base, cwd, put, shell, hook, call, context, log }
}

test('Git worktree and stash inspection forms target their repository without becoming writes', async t => {
  const f = await fixture(t)
  for (const command of ['git worktree list', 'git worktree list --porcelain', 'git stash list', 'git stash show --stat', 'git -c color.ui=false worktree list']) {
    assert.deepEqual(f.shell(command), { kind: 'read', paths: [f.cwd] }, command)
  }
  await mkdir(join(f.cwd, 'nested'))
  assert.deepEqual(f.shell('git -C nested worktree list'), { kind: 'read', paths: [join(f.cwd, 'nested')] })
})

test('Git inspection subcommands are syntax even when matching paths exist', async t => {
  const f = await fixture(t)
  await f.put('project/list/AGENTS.md', 'UNRELATED list directory\n')
  await f.put('project/show/AGENTS.md', 'UNRELATED show directory\n')
  for (const command of ['git worktree list', 'git stash list', 'git stash show']) {
    assert.deepEqual(f.shell(command), { kind: 'read', paths: [f.cwd] }, command)
  }
})

test('Git worktree and stash mutations retain the write boundary', async t => {
  const f = await fixture(t)
  for (const command of [
    'git worktree add ../new-task feature', 'git worktree remove ../old-task', 'git worktree move ../old-task ../new-task',
    'git worktree lock ../task', 'git worktree unlock ../task', 'git worktree repair', 'git worktree prune',
    'git stash', 'git stash -u', 'git stash push', 'git stash pop', 'git stash apply', 'git stash drop', 'git stash clear',
  ]) {
    assert.equal(f.shell(command).kind, 'write', command)
    assert.ok(f.shell(command).paths.includes(f.cwd), command)
  }
  const redirected = f.shell('git worktree list > worktrees.txt')
  assert.equal(redirected.kind, 'write')
  assert.ok(redirected.paths.includes(join(f.cwd, 'worktrees.txt')))
})

test('Git stash inspection output options collect new file destinations as writes', async t => {
  const f = await fixture(t)
  for (const command of ['git stash list --output=report.txt', 'git stash list --output report.txt', 'git stash show --output=report.txt']) {
    assert.deepEqual(f.shell(command), { kind: 'write', paths: [f.cwd, join(f.cwd, 'report.txt')] }, command)
  }
  assert.deepEqual(f.shell('git stash show "--output=my report.txt"'), { kind: 'write', paths: [f.cwd, join(f.cwd, 'my report.txt')] })
  assert.deepEqual(f.shell('git stash list --output=/dev/null'), { kind: 'read', paths: [f.cwd] })
  assert.deepEqual(f.shell('git stash list -- --output=report.txt'), { kind: 'read', paths: [f.cwd] })
})

for (const runtime of ['codex', 'claude']) {
  test(`${runtime}: stash inspection output under unseen rules blocks before writing`, async t => {
    const f = await fixture(t)
    await f.hook(runtime, 'SessionStart', { source: 'startup' })
    await f.put('reports/AGENTS.md', 'REPORT rules\n')
    const report = join(f.base, 'reports/result.txt')
    const command = `git stash list --output=${report}`
    const blocked = await f.call(runtime, command)
    assert.equal(blocked.exitCode, 2)
    assert.match(blocked.stderr, /REPORT rules/)
    assert.deepEqual(await f.call(runtime, command), { exitCode: 0 })
  })

  test(`${runtime}: a single-target read retains its directory-specific heading`, async t => {
    const f = await fixture(t)
    await f.hook(runtime, 'SessionStart', { source: 'startup' })
    await f.put('other/AGENTS.md', 'OTHER rules\n')
    const other = await f.put('other/data.txt', 'other data\n')
    const context = f.context(await f.call(runtime, `cat ${other}`))
    assert.ok(context.split('\n')[0].includes(join(f.base, 'other')))
    assert.match(context, /OTHER rules/)
  })

  test(`${runtime}: listing worktrees and reading sibling documentation delivers context without blocking`, async t => {
    const f = await fixture(t)
    await f.hook(runtime, 'SessionStart', { source: 'startup' })
    await f.put('scripts/AGENTS.md', 'SCRIPTS rules\n')
    const doc = await f.put('scripts/worktrees.md', 'documentation\n')
    const result = await f.call(runtime, `git worktree list --porcelain\ncat ${doc}`)
    assert.equal(result.exitCode, 0)
    const context = f.context(result)
    assert.match(context, /SCRIPTS rules/)
    assert.ok(context.includes(`applies under ${join(f.base, 'scripts')}`))
    assert.ok(!context.split('\n')[0].includes(f.cwd), 'sibling rules must not be attributed to the project')
    const row = (await f.log()).at(-1)
    assert.equal(row.kind, 'read')
    assert.equal(row.decision, 'context')
    assert.equal(row.tokens.parts.reduce((sum, part) => sum + part.bytes, 0), Buffer.byteLength(context))
  })

  test(`${runtime}: multi-target read headings do not claim sibling rules govern the first target`, async t => {
    const f = await fixture(t)
    await f.hook(runtime, 'SessionStart', { source: 'startup' })
    await f.put('other/AGENTS.md', 'OTHER rules\n')
    const other = await f.put('other/data.txt', 'other data\n')
    const context = f.context(await f.call(runtime, `cat data.txt ${other}`))
    assert.ok(!context.split('\n')[0].includes(f.cwd))
    assert.ok(context.includes(`applies under ${join(f.base, 'other')}`))
    assert.match(context, /OTHER rules/)
  })

  test(`${runtime}: multi-target blocks retain per-file scopes and allow an identical retry`, async t => {
    const f = await fixture(t)
    await f.hook(runtime, 'SessionStart', { source: 'startup' })
    await f.put('other/AGENTS.md', 'OTHER rules\n')
    const other = await f.put('other/data.txt', 'other data\n')
    const command = `printf data > result.txt\ncat ${other}`
    const blocked = await f.call(runtime, command)
    assert.equal(blocked.exitCode, 2)
    assert.ok(!blocked.stderr.split('\n')[0].includes(f.cwd))
    assert.ok(blocked.stderr.includes(`applies under ${join(f.base, 'other')}`))
    assert.match(blocked.stderr, /Re-issue the same call now/)
    const retry = await f.call(runtime, command)
    assert.deepEqual(retry, { exitCode: 0 })
    assert.ok((await f.log()).at(-1).retryOfMs >= 0)
  })

  test(`${runtime}: multi-target covered references retain the sibling scope`, async t => {
    const f = await fixture(t)
    await f.hook(runtime, 'SessionStart', { source: 'startup' })
    await f.put('twin/AGENTS.md', 'PROJECT rules\n')
    const twin = await f.put('twin/data.txt', 'twin data\n')
    const context = f.context(await f.call(runtime, `cat data.txt ${twin}`))
    assert.ok(!context.split('\n')[0].includes(f.cwd))
    assert.match(context, /already in context/)
    assert.ok(context.includes(`applies under ${join(f.base, 'twin')}`))
    assert.doesNotMatch(context, /PROJECT rules/)
  })
}
