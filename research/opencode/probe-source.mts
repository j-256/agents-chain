import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { parseArgs } from 'node:util'
import assert from 'node:assert/strict'

const help = 'Usage: bun probe-source.mts [-h|--help] SOURCE_CHECKOUT\nRequires Bun, effect@4.0.0-beta.83, and the v1.18.19 source checkout\nExecutes instruction.ts with mocked platform services and fixture-only files\nWrites JSON to stdout and diagnostics to stderr; makes no model or network calls\nExit: 0 success, 1 runtime/assertion failure, 2 usage/precondition error, 3 missing dependency'
let args
try {
  args = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { help: { type: 'boolean', short: 'h' } } })
} catch (error) { console.error(String(error)); process.exit(2) }
if (args.values.help) { console.log(help); process.exit(0) }
if (args.positionals.length !== 1) { console.error(help); process.exit(2) }
let effect
try { effect = await import('effect') } catch { console.error('Missing dependency: effect@4.0.0-beta.83'); process.exit(3) }
const { Effect, Layer, Context } = effect
// Execute the pinned instruction service, replacing platform services with local fixtures
const sourceRoot = path.resolve(args.positionals[0])
const source = path.join(sourceRoot, 'packages/opencode/src/session/instruction.ts')
if (!(await fs.stat(source).catch(() => null))?.isFile()) { console.error('Source checkout lacks instruction.ts'); process.exit(2) }
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-instruction-source-'))
const state = { directory: '', worktree: '', config: {}, global: {}, flags: {}, disabled: false }
const services: Record<string, any> = {}
for (const name of ['Config', 'FSUtil', 'Global', 'RuntimeFlags', 'HttpClient']) {
  services[name] = class extends Context.Service<any, any>()(`probe/${name}`) {}
}
const safe = (fn: () => Promise<any>) => Effect.tryPromise({ try: fn, catch: x => x })
const exists = (p: string) => safe(() => fs.access(p).then(() => true, () => false))
const glob = (pattern: string, options: any) => safe(async () => {
  const out = []
  for await (const f of new Bun.Glob(pattern).scan({ cwd: options.cwd, absolute: true, onlyFiles: true, dot: options.dot })) out.push(f)
  return out
})
// These walk functions are copied without algorithm changes from the pinned FSUtil implementation
const findUp = (target: string, start: string, stop?: string) => Effect.gen(function* () {
  const result: string[] = []
  let current = start
  while (true) {
    const search = path.join(current, target)
    if (yield* exists(search)) result.push(search)
    if (stop === current) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return result
})
const globUp = (pattern: string, start: string, stop?: string) => Effect.gen(function* () {
  const result: string[] = []
  let current = start
  while (true) {
    const matches = yield* glob(pattern, { cwd: current, absolute: true, include: 'file', dot: true }).pipe(Effect.catch(() => Effect.succeed([])))
    result.push(...matches)
    if (stop === current) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return result
})
const mock = {
  Effect, Layer, Context,
  Config: { Service: services.Config, node: {} },
  FSUtil: { Service: services.FSUtil, node: {} },
  Global: { Service: services.Global, node: {} },
  RuntimeFlags: { Service: services.RuntimeFlags, node: {} },
  HttpClient: { HttpClient: services.HttpClient, filterStatusOk: x => x },
  HttpClientRequest: { get: x => x },
  LayerNode: { make: x => x },
  Flag: { get OPENCODE_DISABLE_PROJECT_CONFIG() { return state.disabled } },
  httpClient: {},
  withTransientReadRetry: x => x,
  InstanceState: {
    make: init => init(),
    get: value => Effect.succeed(value),
    get context() { return Effect.succeed({ directory: state.directory, worktree: state.worktree }) },
    get directory() { return Effect.succeed(state.directory) },
  },
}
;(globalThis as any).__instructionProbeMock = mock
const buildResult = await Bun.build({
  entrypoints: [source],
  outdir: fixture,
  target: 'bun',
  plugins: [{
  name: 'isolated-instruction-services',
  setup(build) {
    build.onResolve({ filter: /^(?:@opencode-ai\/core\/|@\/|effect\/unstable\/http$)/ }, args => ({ path: args.path, namespace: 'probe' }))
    build.onResolve({ filter: /^effect$/ }, args => ({ path: args.path, namespace: 'probe' }))
    build.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({ contents: Object.keys(mock).map(k => `export const ${k} = globalThis.__instructionProbeMock.${k}`).join('\n'), loader: 'js' }))
  },
}]})
if (!buildResult.success) throw new Error(buildResult.logs.map(String).join('\n'))
const mod = await import(buildResult.outputs[0].path)
const write = async (name: string, text: string) => {
  const p = path.join(fixture, name)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, text)
  return p
}
const unlink = (name: string) => fs.unlink(path.join(fixture, name))
const reset = async (directory = 'project', worktree = 'project', config: any = {}, flags: any = {}) => {
  state.directory = path.join(fixture, directory)
  state.worktree = path.join(fixture, worktree)
  state.config = config
  state.global = { config: path.join(fixture, 'global'), home: path.join(fixture, 'home') }
  state.flags = flags
  state.disabled = false
  await fs.mkdir(state.directory, { recursive: true })
}
const checks: any[] = []
const check = (name: string, actual: any, expected: any) => {
  assert.deepEqual(actual, expected, name)
  checks.push({ name, actual })
}
const run = async (fn: (svc: any) => any) => {
  const deps = Layer.mergeAll(
    Layer.succeed(services.Config, { get: () => Effect.succeed(state.config) }),
    Layer.succeed(services.Global, state.global),
    Layer.succeed(services.RuntimeFlags, state.flags),
    Layer.succeed(services.FSUtil, { findUp, globUp, glob, existsSafe: exists, readFileString: p => safe(() => fs.readFile(p, 'utf8')) }),
    Layer.succeed(services.HttpClient, { execute: () => Effect.die(new Error('Network forbidden in this probe')) }),
  )
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () { return yield* fn(yield* mod.Service) }).pipe(Effect.provide(mod.node.layer.pipe(Layer.provide(deps))))))
}
const basenamePaths = (paths: Iterable<string>) => Array.from(paths).map(p => path.relative(fixture, p))
await reset('project/mid/leaf')
await write('global/AGENTS.md', 'GLOBAL')
await write('home/.claude/CLAUDE.md', 'GLOBAL_CLAUDE')
await write('AGENTS.md', 'ABOVE_PROJECT')
await write('project/AGENTS.md', 'ROOT')
await write('project/mid/AGENTS.md', 'MID')
await write('project/mid/leaf/AGENTS.md', 'LEAF')
await write('project/mid/leaf/CLAUDE.md', 'LOCAL_CLAUDE')
await run(s => Effect.gen(function* () {
  check('startup order is global then leaf-to-root AGENTS, without outer or CLAUDE', basenamePaths(yield* s.systemPaths()), ['global/AGENTS.md','project/mid/leaf/AGENTS.md','project/mid/AGENTS.md','project/AGENTS.md'])
  check('startup output preserves discovery order', (yield* s.system()).map(x => x.split('\n').at(-1)), ['GLOBAL','LEAF','MID','ROOT'])
}))
await unlink('global/AGENTS.md')
await run(s => Effect.gen(function* () {
  check('global CLAUDE fallback is independent of project AGENTS', basenamePaths(yield* s.systemPaths())[0], 'home/.claude/CLAUDE.md')
}))
await unlink('project/mid/leaf/AGENTS.md')
await run(s => Effect.gen(function* () {
  check('ancestor AGENTS suppresses nearer CLAUDE across the startup category', basenamePaths(yield* s.systemPaths()), ['home/.claude/CLAUDE.md','project/mid/AGENTS.md','project/AGENTS.md'])
}))
await unlink('project/mid/AGENTS.md')
await unlink('project/AGENTS.md')
await run(s => Effect.gen(function* () {
  check('project CLAUDE fallback when no AGENTS in worktree chain', basenamePaths(yield* s.systemPaths()), ['home/.claude/CLAUDE.md','project/mid/leaf/CLAUDE.md'])
}))
await reset('project/mid/leaf', 'project', {}, { disableClaudeCodePrompt: true })
await write('project/mid/leaf/CONTEXT.md', 'LEGACY')
await run(s => Effect.gen(function* () {
  check('disableClaudeCodePrompt disables project and global CLAUDE; legacy fallback survives', basenamePaths(yield* s.systemPaths()), ['project/mid/leaf/CONTEXT.md'])
}))
await reset()
await write('global/AGENTS.md', 'GLOBAL')
await write('project/AGENTS.md', 'ROOT')
await write('project/sub/AGENTS.md', 'SUB')
await write('project/sub/deep/CLAUDE.md', 'DEEP_CLAUDE')
await run(s => Effect.gen(function* () {
  const p = path.join(fixture, 'project/sub/deep/file.txt')
  const first = yield* s.resolve([], p, 'msg_1')
  check('dynamic order is nearest-to-root; per-directory fallback mixes CLAUDE and AGENTS', basenamePaths(first.map(x => x.filepath)), ['project/sub/deep/CLAUDE.md','project/sub/AGENTS.md'])
  check('per-message claims suppress a second attachment', yield* s.resolve([], p, 'msg_1'), [])
  yield* s.clear('msg_1')
  check('clear permits attachment again', (yield* s.resolve([], p, 'msg_1')).length, 2)
  const messages = [{ parts: [{ type: 'tool', tool: 'read', state: { status: 'completed', metadata: { loaded: first.map(x => x.filepath) }, time: {} } }] }]
  check('completed read metadata suppresses later messages', yield* s.resolve(messages, p, 'msg_2'), [])
  yield* safe(() => write('project/sub/AGENTS.md', 'CHANGED_SUB'))
  check('changed dynamic file remains suppressed by read metadata', yield* s.resolve(messages, p, 'msg_3'), [])
  messages[0].parts[0].state.time = { compacted: 1 } as any
  check('pruned read metadata permits rediscovery', (yield* s.resolve(messages, p, 'msg_4')).length, 2)
  check('outside sibling without shared string prefix is excluded', yield* s.resolve([], path.join(fixture, 'elsewhere/file.txt'), 'msg_5'), [])
  check('root instruction is excluded from dynamic attachment', yield* s.resolve([], path.join(fixture, 'project/file.txt'), 'msg_6'), [])
  check('reading an instruction file skips attaching that same file', basenamePaths((yield* s.resolve([], path.join(fixture, 'project/sub/deep/CLAUDE.md'), 'msg_7')).map(x => x.filepath)), ['project/sub/AGENTS.md'])
  yield* safe(() => write('project/AGENTS.md', 'CHANGED_ROOT'))
  check('ambient contents reread between system calls', (yield* s.system())[1].split('\n').at(-1), 'CHANGED_ROOT')
}))
await write('project-neighbor/AGENTS.md', 'PREFIX_SIBLING')
await run(s => Effect.gen(function* () {
  check('string-prefix sibling boundary edge', basenamePaths((yield* s.resolve([], path.join(fixture, 'project-neighbor/file.txt'), 'msg_edge')).map(x => x.filepath)), ['project-neighbor/AGENTS.md'])
}))
await write('project/sub/rules.md', 'SUBRULE')
await write('project/rules.md', 'ROOTRULE')
await reset('project/sub', 'project', { instructions: ['rules.md', path.join(fixture, 'project/AGENTS.md'), '~/extra.md'] })
await write('home/extra.md', 'HOME_EXTRA')
await run(s => Effect.gen(function* () {
  check('configured entries follow native files; relative searches each ancestor; exact paths dedupe', basenamePaths(yield* s.systemPaths()), ['global/AGENTS.md','project/sub/AGENTS.md','project/AGENTS.md','project/sub/rules.md','project/rules.md','home/extra.md'])
}))
await write('project/sub/AGENTS.md', 'X'.repeat(100000) + 'END_LARGE_INSTRUCTION')
await reset()
await run(s => Effect.gen(function* () {
  const out = yield* s.resolve([], path.join(fixture, 'project/sub/file.txt'), 'msg_large')
  check('100 KB nearby instruction content is returned in full by service', out[0].content.endsWith('END_LARGE_INSTRUCTION'), true)
}))
await reset()
state.disabled = true
await write('global/rules.md', 'GLOBALRULE')
state.config = { instructions: ['rules.md'] }
await run(s => Effect.gen(function* () {
  check('project config disabled: startup project files absent and relative config uses global dir', basenamePaths(yield* s.systemPaths()), ['global/AGENTS.md','global/rules.md'])
  check('project config disabled still permits dynamic nested instructions', (yield* s.resolve([], path.join(fixture, 'project/sub/file.txt'), 'msg_disabled')).length, 1)
}))
console.log(JSON.stringify({ mode: 'exact instruction.ts with mocked platform services; no model or network calls', source, fixture, checks }, null, 2))
