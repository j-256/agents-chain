import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

test('the archive installs independently and preserves real hook retry behavior', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'agents-chain-package.'))
  const fixture = await mkdtemp(join(homedir(), '.agents-chain-package-test.'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], { cwd: root, encoding: 'utf8' })
  assert.equal(packed.status, 0, packed.stderr)
  const info = JSON.parse(packed.stdout)[0]
  const files = info.files.map(f => f.path)
  for (const required of ['README.md', 'INSTALL.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'research/opencode/probe-source.mts', 'docs/behavior.md', 'docs/handling.md', 'docs/probes.md', 'lib/state.mjs', 'hooks/claude.mjs', 'hooks/codex.mjs']) assert.ok(files.includes(required), required)
  assert.ok(files.every(path => !path.startsWith('test/') && !path.includes('.git/')))
  const prefix = join(temp, 'prefix with spaces')
  const installed = spawnSync('npm', ['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, info.filename)], { encoding: 'utf8' })
  assert.equal(installed.status, 0, installed.stderr)
  const packageRoot = join(prefix, 'node_modules/agents-chain')
  const help = spawnSync(process.execPath, [join(packageRoot, 'agents-chain-report'), '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--usage-file/)
  await mkdir(join(fixture, 'start'))
  await mkdir(join(fixture, 'rules'))
  await writeFile(join(fixture, 'rules', 'AGENTS.md'), 'Package-specific instructions\n')
  for (const runtime of ['claude', 'codex']) {
    const payload = { session_id: `package-${runtime}`, hook_event_name: 'PreToolUse', cwd: join(fixture, 'start'), tool_name: 'Bash', tool_input: { command: `printf 'probe\\n' >> '${join(fixture, 'rules', 'output.txt')}'` } }
    const options = { encoding: 'utf8', input: JSON.stringify(payload), env: { ...process.env, AGENTS_CHAIN_DISABLE: '0', AGENTS_CHAIN_MODE: 'live', XDG_STATE_HOME: join(temp, 'state') } }
    const hook = join(packageRoot, 'hooks', `${runtime}.mjs`)
    const first = spawnSync(process.execPath, [hook], options)
    assert.equal(first.status, 2, first.stderr)
    assert.match(first.stderr, /Package-specific instructions/)
    const retry = spawnSync(process.execPath, [hook], options)
    assert.equal(retry.status, 0, retry.stderr)
    assert.equal(retry.stdout, '')
  }
})

test('the generic probe fixture keeps answers private and emits usable isolated settings', async t => {
  const result = spawnSync(process.execPath, [join(root, 'examples', 'probe.mjs')], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const info = JSON.parse(result.stdout)
  t.after(() => rm(info.root, { recursive: true, force: true }))
  assert.ok(info.root.startsWith(homedir()))
  const expected = JSON.parse(await readFile(join(info.root, 'expected.json'), 'utf8'))
  for (const code of Object.values(expected)) assert.ok(!result.stdout.includes(code))
  const settings = JSON.parse(await readFile(join(info.root, 'claude-settings.json'), 'utf8'))
  assert.ok(settings.hooks.SessionStart && settings.hooks.PreToolUse)
  const override = await readFile(join(info.root, 'codex-override.toml'), 'utf8')
  assert.match(override, /hooks.PreToolUse/)
  assert.doesNotMatch(override, /--log-only/)
})
