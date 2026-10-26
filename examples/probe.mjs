import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

let options
try { options = parseArgs({ options: { help: { type: 'boolean', short: 'h' } }, allowPositionals: false }).values }
catch { console.error('Usage: node examples/probe.mjs [-h|--help]'); process.exit(2) }
if (options.help) {
  console.log('Usage: node examples/probe.mjs [-h|--help]\nCreates a private fixture under home and prints its path/settings as JSON\nRequires Node.js 22+; makes no model calls and changes no runtime settings\nExpected codes stay in expected.json; delete the generated directory after testing\nExit: 0 success/help, 1 filesystem failure, 2 invalid options')
  process.exit(0)
}
try {
  const parent = join(homedir(), '.cache', 'agents-chain', 'probes')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'probe.'))
  const expected = Object.fromEntries(['readCode', 'writeCode', 'headingCode', 'bodyCode'].map(name => [name, randomBytes(12).toString('hex')]))
  const put = async (file, text) => writeFile(join(root, file), text, { mode: 0o600 })
  for (const dir of ['start', 'read', 'write', 'large']) await mkdir(join(root, dir), { mode: 0o700 })
  await put('read/AGENTS.md', `# Read instructions\nThe read code is ${expected.readCode}\n`)
  await put('read/data.txt', 'Ordinary read payload\n')
  await put('write/AGENTS.md', `# Write instructions\nThe write code is ${expected.writeCode}\n`)
  await put('large/AGENTS.md', `# Outline ${expected.headingCode}\n## Formatting\n## Test commands\n` + 'Filler paragraph\n'.repeat(5000) + `The body-only code is ${expected.bodyCode}\n`)
  await put('large/data.txt', 'Ordinary outline payload\n')
  await put('expected.json', JSON.stringify(expected, null, 2) + '\n')
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const command = runtime => `AGENTS_CHAIN_DISABLE=0 AGENTS_CHAIN_MODE=live XDG_STATE_HOME=${quote(join(root, `${runtime}-state`))} ${quote(process.execPath)} ${quote(fileURLToPath(new URL(`../hooks/${runtime}.mjs`, import.meta.url)))}`
  const handler = runtime => ({ type: 'command', command: command(runtime), timeout: 10 })
  const hooks = runtime => ({ SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [handler(runtime)] }], PreToolUse: [{ matcher: runtime === 'codex' ? '^(apply_patch|Bash|exec_command)$' : '^(Bash|Read|Write|Edit|MultiEdit|NotebookEdit)$', hooks: [handler(runtime)] }] })
  await put('claude-settings.json', JSON.stringify({ pluginConfigs: { 'cc-plugin-agents-md@builtin': { options: { instructionFiles: 'claude-md-and-agents-md' } } }, hooks: hooks('claude') }, null, 2) + '\n')
  await put('codex-start.toml', `hooks.SessionStart=[{matcher="startup|resume|clear|compact",hooks=[{type="command",command=${JSON.stringify(command('codex'))},timeout=10}]}]\n`)
  await put('codex-override.toml', `hooks.PreToolUse=[{matcher="^(apply_patch|Bash|exec_command)$",hooks=[{type="command",command=${JSON.stringify(command('codex'))},timeout=10}]}]\n`)
  console.log(JSON.stringify({ root, start: join(root, 'start'), expected: join(root, 'expected.json'), claudeSettings: join(root, 'claude-settings.json'), codexOverride: join(root, 'codex-override.toml'), codexStart: join(root, 'codex-start.toml') }, null, 2))
} catch { console.error('Unable to create the probe fixture'); process.exitCode = 1 }
