import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUDGET, KIND, bounceReason, packContext, toolTargets } from '../lib/agents-chain-tools.mjs'

const CWD = '/workspace/repo'

test('delivery accounting partitions rendered Unicode text without retaining contents', () => {
  const result = packContext('/a', [{ path: '/a/AGENTS.md', text: 'é🧪\n' }], BUDGET.codex, [], { epochBudget: 65536 })
  assert.equal(typeof result.accounting, 'function')
  const parts = result.accounting()
  assert.deepEqual(parts.find(p => p.kind === 'full'), { path: '/a/AGENTS.md', kind: 'full', bytes: Buffer.byteLength('== /a/AGENTS.md (applies under /a) ==\né🧪') })
  assert.equal(parts.reduce((n, p) => n + p.bytes, 0), Buffer.byteLength(result.text))
  assert.ok(parts.some(p => p.kind === 'wrapper' && p.bytes > 0))
  assert.doesNotMatch(JSON.stringify(parts), /é|🧪|text/)
})

test('accounting excludes deferred files and includes outlines, covered notes and size notes', () => {
  const entries = Array.from({ length: 8 }, (_, i) => ({ path: `/a/${i}/AGENTS.md`, text: '# Heading\n' + 'x'.repeat(12000) }))
  const packed = packContext('/a', entries, 800, [], { epochBudget: 0 })
  assert.equal(typeof packed.accounting, 'function')
  const parts = packed.accounting()
  assert.ok(packed.deferred.length > 0)
  assert.ok(parts.some(p => p.kind === 'outline'))
  assert.ok(parts.every(p => !packed.deferred.includes(p.path)))
  assert.equal(parts.reduce((n, p) => n + p.bytes, 0), Buffer.byteLength(packed.text))
  const noted = packContext('/a', entries.slice(0, 1), BUDGET.claude, [{ path: '/b/AGENTS.md', twin: '/original/AGENTS.md' }], { epochBudget: 65536 })
  assert.deepEqual(noted.accounting().filter(p => p.path).map(p => p.kind).sort(), ['covered', 'note'])
  assert.equal(noted.accounting().reduce((n, p) => n + p.bytes, 0), Buffer.byteLength(noted.text))
  const bounced = bounceReason('/a', entries, 900, [], { epochBudget: 0 })
  assert.equal(bounced.accounting().reduce((n, p) => n + p.bytes, 0), Buffer.byteLength(bounced.text))
})

test('file tools classify by tool name and use their path fields', () => {
  const cases = [
    [{ tool_name: 'Read', tool_input: { file_path: '/workspace/sh/wt' } }, KIND.READ, ['/workspace/sh/wt']],
    [{ tool_name: 'Edit', tool_input: { file_path: '/workspace/sh/wt' } }, KIND.WRITE, ['/workspace/sh/wt']],
    [{ tool_name: 'Write', tool_input: { file_path: '/workspace/new/dir/f.txt' } }, KIND.WRITE, ['/workspace/new/dir/f.txt']],
    [{ tool_name: 'MultiEdit', tool_input: { file_path: '/workspace/a.txt' } }, KIND.WRITE, ['/workspace/a.txt']],
    [{ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/n/a.ipynb' } }, KIND.WRITE, ['/n/a.ipynb']],
    [{ tool_name: 'Glob', tool_input: { pattern: '*' } }, KIND.NONE, []],
    [{ tool_name: 'Read', tool_input: {} }, KIND.NONE, []],
  ]
  for (const [payload, kind, paths] of cases) {
    assert.deepEqual(toolTargets({ cwd: CWD, ...payload }), { kind, paths }, JSON.stringify(payload))
  }
})

test('apply_patch is a write to every file header path, relative to cwd', () => {
  const command = '*** Begin Patch\n*** Add File: sub/new.txt\n+x\n*** Update File: a.txt\n@@\n-old\n+new\n*** Move to: b/c.txt\n*** Delete File: /abs/gone.txt\n*** End Patch'
  assert.deepEqual(toolTargets({ cwd: CWD, tool_name: 'apply_patch', tool_input: { command } }), {
    kind: KIND.WRITE,
    paths: ['/workspace/repo/sub/new.txt', '/workspace/repo/a.txt', '/workspace/repo/b/c.txt', '/abs/gone.txt'],
  })
})

async function shellFixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agents-chain-tools.')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'f.txt'), 'f\n')
  await mkdir(join(dir, 'my dir'))
  await writeFile(join(dir, 'my dir', 'g.txt'), 'g\n')
  await mkdir(join(dir, 'sub'))
  await writeFile(join(dir, 'sub', 'h.txt'), 'h\n')
  const shell = command => toolTargets({ cwd: dir, tool_name: 'Bash', tool_input: { command } })
  return { dir, shell }
}

test('shell commands keep only existing paths and classify reads', async t => {
  const { dir, shell } = await shellFixture(t)
  assert.deepEqual(shell('cat f.txt'), { kind: KIND.READ, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('cat "my dir/g.txt"'), { kind: KIND.READ, paths: [join(dir, 'my dir', 'g.txt')] })
  assert.deepEqual(shell("cat 'my dir'/g.txt"), { kind: KIND.READ, paths: [join(dir, 'my dir', 'g.txt')] })
  assert.deepEqual(shell('cd sub && cat h.txt'), { kind: KIND.READ, paths: [join(dir, 'sub'), join(dir, 'sub', 'h.txt')] })
  assert.deepEqual(shell('git -C sub status'), { kind: KIND.READ, paths: [join(dir, 'sub')] })
  assert.deepEqual(shell(`grep -n x ${join(dir, 'f.txt')} | head`), { kind: KIND.READ, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('ls nothing-here'), { kind: KIND.NONE, paths: [] })
  assert.deepEqual(shell('echo hello'), { kind: KIND.NONE, paths: [] })
})

test('shell commands classify writes, including redirects to new files', async t => {
  const { dir, shell } = await shellFixture(t)
  assert.deepEqual(shell('echo hi > new.txt'), { kind: KIND.WRITE, paths: [join(dir, 'new.txt')] })
  assert.deepEqual(shell('echo hi >> f.txt'), { kind: KIND.WRITE, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('sed -i s/a/b/ f.txt'), { kind: KIND.WRITE, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('cd sub; rm h.txt'), { kind: KIND.WRITE, paths: [join(dir, 'sub'), join(dir, 'sub', 'h.txt')] })
  assert.deepEqual(shell('git -C sub commit -m x -- h.txt'), { kind: KIND.WRITE, paths: [join(dir, 'sub'), join(dir, 'sub', 'h.txt')] })
  assert.deepEqual(shell('cat f.txt | tee sub/copy.txt'), { kind: KIND.WRITE, paths: [join(dir, 'f.txt'), join(dir, 'sub', 'copy.txt')] })
  assert.deepEqual(shell('mkdir -p sub/new && touch sub/new/x.txt'), { kind: KIND.WRITE, paths: [join(dir, 'sub', 'new'), join(dir, 'sub', 'new', 'x.txt')] })
  assert.deepEqual(shell('echo hi > missing-dir/new.txt'), { kind: KIND.WRITE, paths: [join(dir, 'missing-dir', 'new.txt')] })
  assert.deepEqual(shell('git commit -m x'), { kind: KIND.WRITE, paths: [dir] })
  assert.deepEqual(shell('cd sub && git commit -m x'), { kind: KIND.WRITE, paths: [join(dir, 'sub')] })
  assert.deepEqual(shell('cp f.txt sub/copy.txt'), { kind: KIND.WRITE, paths: [join(dir, 'f.txt'), join(dir, 'sub', 'copy.txt')] })
  assert.deepEqual(shell('rm f.txt; cd sub'), { kind: KIND.WRITE, paths: [join(dir, 'f.txt'), join(dir, 'sub')] })
})

test('shell redirects to /dev and file-descriptor duplication are not writes', async t => {
  const { dir, shell } = await shellFixture(t)
  assert.deepEqual(shell('cat f.txt 2>/dev/null'), { kind: KIND.READ, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('cat f.txt >/dev/null 2>&1'), { kind: KIND.READ, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('cat f.txt &>/dev/null'), { kind: KIND.READ, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('echo oops >&2'), { kind: KIND.NONE, paths: [] })
})

test('heredoc bodies and comments are not parsed as commands', async t => {
  const { dir, shell } = await shellFixture(t)
  const commit = "git commit -q -F /dev/stdin -- f.txt <<'EOF'\nUpdate f.txt: move > sub/h.txt and rm f.txt\n\n- Bullet\nEOF"
  assert.deepEqual(shell(commit), { kind: KIND.WRITE, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('cat f.txt # then rm sub/h.txt'), { kind: KIND.READ, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('grep x <<< "rm f.txt"'), { kind: KIND.NONE, paths: [] })
})

test('shell path candidates are capped at 20', async t => {
  const { dir, shell } = await shellFixture(t)
  const names = Array.from({ length: 25 }, (_, i) => `n${i}.txt`)
  await Promise.all(names.map(name => writeFile(join(dir, name), 'n\n')))
  const result = shell(`cat ${names.join(' ')}`)
  assert.equal(result.kind, KIND.READ)
  assert.equal(result.paths.length, 20)
  assert.equal(result.paths[0], join(dir, 'n0.txt'))
})

test('Codex shell tool names and nested names classify like Bash', async t => {
  const { dir } = await shellFixture(t)
  for (const tool_name of ['exec_command', 'functions.exec_command']) {
    assert.deepEqual(toolTargets({ cwd: dir, tool_name, tool_input: { cmd: 'cat f.txt' } }), { kind: KIND.READ, paths: [join(dir, 'f.txt')] })
  }
})

const HEADER = dir => `AGENTS.md instructions that govern ${dir} were not yet in context:`
const RETRY = 'The tool call was not run so these instructions could be read first. Re-issue the same call now.'

test('budgets match the spec', () => {
  assert.deepEqual({ ...BUDGET }, { claude: 9500, codex: 32000, bounce: 40000 })
})

test('packContext lays out files outermost first under the header', () => {
  const entries = [{ path: '/workspace/repo/AGENTS.md', text: 'outer rules\n' }, { path: '/workspace/repo/3p/AGENTS.md', text: 'inner rules\n' }]
  const result = packContext('/workspace/repo/3p/project', entries, BUDGET.claude)
  assert.equal(result.text, [
    HEADER('/workspace/repo/3p/project'),
    '',
    '== /workspace/repo/AGENTS.md (applies under /workspace/repo) ==',
    'outer rules',
    '',
    '== /workspace/repo/3p/AGENTS.md (applies under /workspace/repo/3p) ==',
    'inner rules',
  ].join('\n'))
  assert.deepEqual(result.sent, ['/workspace/repo/AGENTS.md', '/workspace/repo/3p/AGENTS.md'])
  assert.deepEqual(result.noted, [])
})

test('packContext keeps the nearest files within budget and notes the rest', () => {
  const entries = [{ path: '/a/AGENTS.md', text: 'o'.repeat(6000) }, { path: '/a/b/AGENTS.md', text: 'n'.repeat(6000) }]
  const result = packContext('/a/b', entries, BUDGET.claude)
  assert.deepEqual(result.sent, ['/a/b/AGENTS.md'])
  assert.deepEqual(result.noted, ['/a/AGENTS.md'])
  assert.ok(result.text.length <= BUDGET.claude)
  assert.ok(result.text.includes('Not included because of the hook size limit: /a/AGENTS.md (6000 bytes) applies under /a; it will be delivered in full before the first write there.'))
  assert.ok(!result.text.includes('o'.repeat(100)))
  assert.deepEqual(packContext('/a', [], BUDGET.claude), { text: '', sent: [], noted: [] })
})

test('bounceReason ends with the retry line and names files past its budget', () => {
  const small = bounceReason('/a/b', [{ path: '/a/AGENTS.md', text: 'rules\n' }], BUDGET.bounce)
  assert.equal(small.text, [HEADER('/a/b'), '', '== /a/AGENTS.md (applies under /a) ==', 'rules', '', RETRY].join('\n'))
  assert.deepEqual(small.sent, ['/a/AGENTS.md'])
  const big = bounceReason('/a/b/c', ['/a', '/a/b', '/a/b/c'].map(dir => ({ path: `${dir}/AGENTS.md`, text: 'z'.repeat(30000) })), BUDGET.bounce)
  assert.deepEqual(big.sent, ['/a/b/c/AGENTS.md'])
  assert.deepEqual(big.named, ['/a/AGENTS.md', '/a/b/AGENTS.md'])
  assert.ok(big.text.includes('Read these files before continuing:\n- /a/AGENTS.md\n- /a/b/AGENTS.md'))
  assert.ok(big.text.endsWith(RETRY))
  assert.ok(big.text.length <= BUDGET.bounce)
})

test('a changed file that does not fit is noted as changed', () => {
  const result = packContext('/a', [{ path: '/a/AGENTS.md', text: 'c'.repeat(12000), changed: true }], BUDGET.claude)
  assert.deepEqual(result.noted, ['/a/AGENTS.md'])
  assert.ok(result.text.includes('Not included because of the hook size limit: /a/AGENTS.md (12000 bytes) applies under /a and changed after it was delivered; read it directly to see the current version.'))
})

const COMMIT = ['git', 'commit', '-m', 'x'].join(' ')

test('quoted heredoc markers, shell keywords, env and xargs do not hide writes', async t => {
  const { dir, shell } = await shellFixture(t)
  assert.deepEqual(shell('echo "a << b"\nrm f.txt'), { kind: KIND.WRITE, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('if [ -f f.txt ]; then rm f.txt; fi'), { kind: KIND.WRITE, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('for x in a b; do sed -i s/a/b/ f.txt; done'), { kind: KIND.WRITE, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('env FOO=1 rm f.txt'), { kind: KIND.WRITE, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('ls sub | xargs rm'), { kind: KIND.WRITE, paths: [join(dir, 'sub'), dir] })
  for (const command of ['git clean -fd', 'git switch main', 'git pull', 'git worktree add ../w feature']) {
    assert.deepEqual(shell(command), { kind: KIND.WRITE, paths: [dir] }, command)
  }
})

test('variables expand for $PWD and $HOME, and unresolvable directories keep the current one', async t => {
  const { dir, shell } = await shellFixture(t)
  assert.deepEqual(shell('cat "$PWD/f.txt"'), { kind: KIND.READ, paths: [join(dir, 'f.txt')] })
  assert.deepEqual(shell('echo x > "${PWD}/out.txt"'), { kind: KIND.WRITE, paths: [join(dir, 'out.txt')] })
  assert.deepEqual(shell(`cd "$task_worktree" && ${COMMIT}`), { kind: KIND.WRITE, paths: [dir] })
  assert.deepEqual(shell(`cd missing && ${COMMIT}`), { kind: KIND.WRITE, paths: [dir] })
  assert.deepEqual(shell(COMMIT.replace('git', 'git -C "$nowhere"')), { kind: KIND.WRITE, paths: [dir] })
})

test('Codex workdir sets the shell directory and apply_patch through the shell is a patch', async t => {
  const { dir } = await shellFixture(t)
  assert.deepEqual(toolTargets({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat h.txt', workdir: 'sub' } }), { kind: KIND.READ, paths: [join(dir, 'sub', 'h.txt')] })
  const command = "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: sub/n.txt\n+x\n*** End Patch\nEOF"
  assert.deepEqual(toolTargets({ cwd: dir, tool_name: 'Bash', tool_input: { command } }), { kind: KIND.WRITE, paths: [join(dir, 'sub', 'n.txt')] })
})

const COVERED = [{ path: '/worktrees/b/AGENTS.md', twin: '/workspace/b/AGENTS.md' }]
const COVERED_NOTE = 'Same content as /workspace/b/AGENTS.md, already in context: /worktrees/b/AGENTS.md applies under /worktrees/b.'

test('packContext names a covered file by its twin instead of repeating its text', () => {
  const only = packContext('/worktrees/b', [], BUDGET.claude, COVERED)
  assert.equal(only.text, ['AGENTS.md files that govern /worktrees/b repeat instructions already in context:', '', COVERED_NOTE].join('\n'))
  assert.deepEqual({ sent: only.sent, noted: only.noted }, { sent: [], noted: [] })
  const mixed = packContext('/worktrees/b/c', [{ path: '/worktrees/b/c/AGENTS.md', text: 'new rules\n' }], BUDGET.claude, COVERED)
  assert.equal(mixed.text, [HEADER('/worktrees/b/c'), '', '== /worktrees/b/c/AGENTS.md (applies under /worktrees/b/c) ==', 'new rules', '', COVERED_NOTE].join('\n'))
  assert.deepEqual(mixed.sent, ['/worktrees/b/c/AGENTS.md'])
})

test('a file that does not fit keeps the not-yet-in-context header when notes follow', () => {
  const result = packContext('/a', [{ path: '/a/AGENTS.md', text: 'o'.repeat(12000) }], BUDGET.claude, COVERED)
  assert.ok(result.text.startsWith(HEADER('/a')))
  assert.deepEqual(result.noted, ['/a/AGENTS.md'])
})

test('bounceReason puts covered notes before the retry line', () => {
  const result = bounceReason('/worktrees/b/c', [{ path: '/worktrees/b/c/AGENTS.md', text: 'new rules\n' }], BUDGET.bounce, COVERED)
  assert.equal(result.text, [HEADER('/worktrees/b/c'), '', '== /worktrees/b/c/AGENTS.md (applies under /worktrees/b/c) ==', 'new rules', '', COVERED_NOTE, '', RETRY].join('\n'))
})

test('epoch budget chooses full files root first and counts UTF-8 wrappers at the boundary', () => {
  const entries = [{ path: '/a/AGENTS.md', text: '# Outer\n' + 'é'.repeat(80) }, { path: '/a/b/AGENTS.md', text: '# Inner\n' + 'z'.repeat(80) }]
  const one = packContext('/a/b', entries.slice(0, 1), BUDGET.codex)
  const exact = packContext('/a/b', entries.slice(0, 1), BUDGET.codex, [], { epochBudget: Buffer.byteLength(one.text) })
  assert.deepEqual(exact.sent, ['/a/AGENTS.md'])
  const short = packContext('/a/b', entries.slice(0, 1), BUDGET.codex, [], { epochBudget: Buffer.byteLength(one.text) - 1 })
  assert.deepEqual(short.capped, ['/a/AGENTS.md'])
  assert.doesNotMatch(short.text, /é{20}/)
  const both = packContext('/a/b', entries, BUDGET.codex, [], { epochBudget: Buffer.byteLength(one.text) })
  assert.deepEqual(both.sent, ['/a/AGENTS.md'])
  assert.deepEqual(both.capped, ['/a/b/AGENTS.md'])
  assert.ok(both.text.indexOf('/a/AGENTS.md') < both.text.indexOf('/a/b/AGENTS.md'))
})

test('outlines ignore fenced headings and bound multibyte headings with omitted counts', () => {
  const text = ['# Title', '```md', '# Fenced', '```', '~~~', '## Also fenced', '~~~', '### Deep', ...Array.from({ length: 40 }, (_, i) => `## H${i} ${'é'.repeat(500)}`), 'BODY SECRET'].join('\n')
  const packed = packContext('/a', [{ path: '/a/AGENTS.md', text }], BUDGET.codex, [], { epochBudget: 0 })
  assert.match(packed.text, /# Title/)
  assert.match(packed.text, /more headings omitted/)
  assert.match(packed.text, new RegExp(`${Buffer.byteLength(text)} bytes`))
  assert.doesNotMatch(packed.text, /Fenced|Also fenced|Deep|BODY SECRET/)
  assert.ok(Buffer.byteLength(packed.text) < 2200)
  assert.deepEqual(packed.capped, ['/a/AGENTS.md'])
})

test('shell miss counters ignore comments, heredocs and known expansions and expose no words', async t => {
  const { dir } = await shellFixture(t)
  const observations = {}
  const result = toolTargets({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat "$PWD/f.txt" "$PRIVATE/path" *.txt $(pwd)/out `pwd`/out # $IGNORE\ncat <<EOF\n$IGNORE/body\nEOF' } }, { observations })
  assert.equal(observations.unresolved, 4)
  assert.deepEqual(Object.keys(observations), ['unresolved'])
  assert.ok(result.paths.includes(join(dir, 'f.txt')))
})

test('combined outlines respect the runtime limit while retaining each applicability notice', () => {
  const entries = Array.from({ length: 8 }, (_, i) => ({ path: `/a/d${i}/AGENTS.md`, text: '# Topic\n' + Array.from({ length: 24 }, (_, n) => `## Heading ${n} ${'x'.repeat(48)}`).join('\n') }))
  const packed = packContext('/a', entries, BUDGET.claude, [], { epochBudget: 0 })
  assert.ok(packed.text.length <= BUDGET.claude, packed.text.length)
  for (const entry of entries) assert.ok(packed.text.includes(entry.path), entry.path)
  assert.deepEqual(packed.capped, entries.map(entry => entry.path))
})

test('epoch eligibility is checked before the runtime size-note fallback', () => {
  const packed = packContext('/a', [{ path: '/a/AGENTS.md', text: '# Topic\n' + 'x'.repeat(70000) }], BUDGET.codex, [], { epochBudget: 65536 })
  assert.deepEqual(packed.capped, ['/a/AGENTS.md'])
  assert.deepEqual(packed.noted, [])
  assert.match(packed.text, /# Topic/)
})
