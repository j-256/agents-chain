// Deliver every AGENTS.md that governs a path, once per session, in both runtimes
// Reads receive the chain as added context; the first write under a directory with
// undelivered files is blocked once with the chain as the reason, then retried
// The hook fails open: an internal error never blocks or alters a tool call
// State holds paths, file identities and hashes only; logs never hold file or command text
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Store, atomicJson, isAlive, readPrivateJson, secureDirectory, stateRoot } from './state.mjs'
import { BUDGET, KIND, bounceReason, isShellCall, packContext, toolTargets } from './agents-chain-tools.mjs'
import { chainOptions, fileIdentity, governingFiles, linkedWorktree, nativeFiles, readGoverning, realDirectory } from './agents-chain-files.mjs'
import { instrumentDecision } from './agents-chain-instrument.mjs'

const SCHEMA_VERSION = 2
const HOOK_VERSION = 3
const MAX_INPUT_BYTES = 1024 * 1024
const MAX_SESSION_ID_LENGTH = 256
const RUNTIMES = new Set(['claude', 'codex'])
const EVENT = Object.freeze({ START: 'SessionStart', PRE: 'PreToolUse' })
const STATUS = Object.freeze({ NATIVE: 'native', SENT: 'sent', NOTED: 'noted' })
const CLASS = Object.freeze({ NEW: 'new', NOTED: 'noted', CHANGED: 'changed', STALE: 'stale', RECENT: 'recent', ACCEPT: 'accept', COVERED: 'covered', SEEN: 'seen' })
const DECISION = Object.freeze({ NONE: 'none', CONTEXT: 'context', BOUNCE: 'bounce' })
const MODE = Object.freeze({ LIVE: 'live', LOG: 'log' })
const SOURCE = Object.freeze({ STARTUP: 'startup', RESUME: 'resume' })
const FILE_NAME = 'AGENTS.md'
const STATE_FILE = 'session.json'
const LOCK_FILE = 'state.lock'
const LOG_FILE = 'log.jsonl'
const BLOCK_EXIT_CODE = 2
// A write this soon after a delivery was issued before the agent could read it,
// unless it is the very call that triggered the delivery being retried
const BOUNCE_WINDOW_MS = 2000
// Codex may compact without a SessionStart, so old deliveries are re-sent as context
const CODEX_RESEND_MS = 4 * 60 * 60 * 1000
const PRUNE_MS = 14 * 24 * 60 * 60 * 1000
const LOG_LIMIT_BYTES = 20 * 1024 * 1024
// The lock covers only a state read-modify-write, so waits stay far below the hook timeout
const LOCK_WAIT_MS = 1500
const LOCK_STALE_MS = 3000
const LOCK_POLL_MS = 20
// Stop before runtime hook timeouts (10 seconds in the golden configuration)
const DEADLINE_MS = 5000
const WORKTREE_CACHE_LIMIT = 256
const CALLS_PER_RECORD = 4
const PRIOR_EPOCH_LIMIT = 2048
export const EPOCH_BYTES_CAP = 64 * 1024
const BOUNCE_CLASSES = new Set([CLASS.NEW, CLASS.NOTED, CLASS.RECENT])
const READ_CLASSES = new Set([CLASS.NEW, CLASS.CHANGED, CLASS.STALE])
const RESEND_CLASSES = new Set([CLASS.CHANGED, CLASS.STALE])
// Classes that need no bounce and no full delivery
const QUIET_CLASSES = new Set([CLASS.SEEN, CLASS.ACCEPT, CLASS.COVERED])
const SOURCE_TOKEN = /^[a-z][a-z_-]{0,31}$/i
const FULL_READ_TOOL = 'Read'
const FULL_WRITE_TOOL = 'Write'

// SessionStart's source goes in the log as a short token, never as arbitrary text
function sourceToken(event, source) {
  if (event !== EVENT.START || source === undefined || source === null) return null
  return typeof source === 'string' && SOURCE_TOKEN.test(source) ? source : 'other'
}

const digest = value => createHash('sha256').update(value).digest('hex')
const depth = path => path.split(sep).length
const quiet = () => ({ exitCode: 0 })
const failure = code => Object.assign(new Error(code), { code })

export function defaultRoot(env = process.env) {
  return join(dirname(stateRoot(env)), 'agents-chain')
}

function validIdentity(runtime, payload) {
  const id = payload?.session_id
  return RUNTIMES.has(runtime) && typeof id === 'string' && id.length > 0 && id.length <= MAX_SESSION_ID_LENGTH &&
    Object.values(EVENT).includes(payload.hook_event_name)
}

function storeKey(runtime, sessionId, agentId, mode) {
  return digest(`${runtime}\0${sessionId}\0${agentId ?? ''}\0${mode}`)
}

async function loadState(path) {
  try {
    const value = await readPrivateJson(path)
    if (value?.version !== SCHEMA_VERSION || !value.files || typeof value.files !== 'object' || !value.worktrees || typeof value.worktrees !== 'object') {
      throw failure('STATE_INVALID')
    }
    value.epochBytes ??= 0
    value.priorEpoch ??= []
    if (!Number.isSafeInteger(value.epochBytes) || value.epochBytes < 0 || !Array.isArray(value.priorEpoch) || value.priorEpoch.some(path => typeof path !== 'string')) throw failure('STATE_INVALID')
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function withLock(dir, callback, timing) {
  const started = Date.now()
  const path = join(dir, LOCK_FILE)
  const token = randomUUID()
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() })) } finally { await handle.close() }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner = null
      try { owner = JSON.parse(await readFile(path, 'utf8')) } catch { /* vanished or partly written */ }
      let age = 0
      try { age = Date.now() - (owner?.at ?? (await stat(path)).mtimeMs) } catch { continue }
      if ((owner && !isAlive(owner.pid)) || age > LOCK_STALE_MS) {
        await unlink(path).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) { timing.lockWaitMs = Date.now() - started; throw failure('LOCK_TIMEOUT') }
      await delay(LOCK_POLL_MS)
    }
  }
  try {
    timing.lockWaitMs = Date.now() - started
    return await callback()
  } finally {
    try {
      if (JSON.parse(await readFile(path, 'utf8')).token === token) await unlink(path)
    } catch { /* already released or broken as stale */ }
  }
}

function findRecord(state, file) {
  return state.files[file.path] ?? Object.values(state.files).find(record => record.id === file.id)
}

function classify(runtime, record, file, now, callHash) {
  if (!record) return CLASS.NEW
  if (record.selfWrite && record.hash !== file.hash) return CLASS.ACCEPT
  if (!record.delivered) return CLASS.NOTED
  if (record.hash !== file.hash) return CLASS.CHANGED
  if (runtime === 'codex' && record.status === STATUS.SENT && now - record.at > CODEX_RESEND_MS) return CLASS.STALE
  if (record.deliveredAt && now - record.deliveredAt < BOUNCE_WINDOW_MS && !(record.by ?? []).includes(callHash)) return CLASS.RECENT
  return CLASS.SEEN
}

async function chainFor(paths, options) {
  const merged = new Map()
  for (const path of paths) {
    let files
    // One unreadable target must not drop the rest of the call
    try { files = await governingFiles(path, options) } catch { continue }
    for (const file of files) if (!merged.has(file.id)) merged.set(file.id, file)
  }
  return [...merged.values()].sort((a, b) => depth(a.path) - depth(b.path))
}

function cachedWorktree(cache) {
  return async dir => {
    if (!Object.hasOwn(cache, dir)) cache[dir] = await linkedWorktree(dir)
    return cache[dir]
  }
}

function mergeWorktrees(state, cache) {
  Object.assign(state.worktrees, cache)
  const keys = Object.keys(state.worktrees)
  for (const key of keys.slice(0, Math.max(0, keys.length - WORKTREE_CACHE_LIMIT))) delete state.worktrees[key]
}

function freshState(startCwd, natives, now, previous) {
  const history = [...(previous?.priorEpoch ?? []), ...Object.entries(previous?.files ?? {}).filter(([, record]) => record.delivered && record.status !== STATUS.NATIVE).map(([path]) => path)]
  const state = { version: SCHEMA_VERSION, startCwd, files: {}, worktrees: {}, epochBytes: 0, priorEpoch: [...new Set(history)].slice(-PRIOR_EPOCH_LIMIT) }
  for (const file of natives) state.files[file.path] = { status: STATUS.NATIVE, id: file.id, hash: file.hash, at: now, delivered: true }
  return state
}

async function mainStartCwd(root, runtime, payload, mode) {
  try {
    const main = new Store(`agents-chain:${storeKey(runtime, payload.session_id, null, mode)}`, root)
    return (await loadState(join(main.dir, STATE_FILE)))?.startCwd ?? null
  } catch { return null }
}

// Calls aimed at an AGENTS.md file itself: a full Claude Read shows the file, a Claude
// Write supplies its new content, and other edits accept the next change silently
async function selfTargets(payload, targets) {
  const tool = String(payload.tool_name ?? '').split('.').at(-1)
  const input = payload.tool_input ?? {}
  const found = []
  for (const path of targets.paths) {
    if (basename(path) !== FILE_NAME) continue
    let real
    try { real = await realpath(path) } catch { real = path }
    let id = null
    try { id = await fileIdentity(real) } catch { /* a new file has no identity yet */ }
    if (tool === FULL_READ_TOOL && input.offset === undefined && input.limit === undefined) {
      const content = await readGoverning(real)
      if (content && id) found.push({ path: real, id, hash: content.hash, effect: 'read' })
    } else if (tool === FULL_WRITE_TOOL && typeof input.content === 'string') {
      found.push({ path: real, id, hash: digest(input.content), effect: 'replace' })
    } else if (targets.kind === KIND.WRITE) found.push({ path: real, id, effect: 'edit' })
  }
  return found
}

function applySelfTargets(state, selves, now) {
  const handled = new Set()
  for (const self of selves) {
    const existing = state.files[self.path] ?? (self.id ? Object.values(state.files).find(record => record.id === self.id) : undefined)
    if (self.effect === 'read' || self.effect === 'replace') {
      state.files[self.path] = { status: STATUS.SENT, id: self.id ?? existing?.id ?? null, hash: self.hash, at: now, delivered: true }
      handled.add(self.path)
    } else if (existing?.delivered) {
      existing.selfWrite = true
      handled.add(self.path)
    }
  }
  return handled
}

function markDelivered(state, files, now, callHash, capped = []) {
  for (const file of files) {
    const previous = findRecord(state, file)
    const recent = previous?.deliveredAt && now - previous.deliveredAt < BOUNCE_WINDOW_MS
    const by = [...(recent ? previous.by ?? [] : []), callHash].slice(-CALLS_PER_RECORD)
    state.files[file.path] = { status: STATUS.SENT, id: file.id, hash: file.hash, at: now, delivered: true, deliveredAt: recent ? previous.deliveredAt : now, by }
    if (capped.includes(file.path)) state.files[file.path].outline = true
  }
}

// Content already in this session's context, by hash, so a byte-identical AGENTS.md
// elsewhere (a sibling worktree, say) is referenced instead of repeated
function deliveredTwins(runtime, state, now) {
  const twins = new Map()
  for (const [path, record] of Object.entries(state.files)) {
    // A noted record holds the hash of content that was not delivered
    if (!record.delivered || !record.hash || record.outline || record.selfWrite || record.sameAs || record.status === STATUS.NOTED || twins.has(record.hash)) continue
    // Codex deliveries older than the re-send age may have been compacted away
    if (runtime === 'codex' && record.status === STATUS.SENT && now - record.at > CODEX_RESEND_MS) continue
    twins.set(record.hash, path)
  }
  return twins
}

function markCovered(state, covered, now) {
  for (const { file, twin } of covered) {
    state.files[file.path] = { status: STATUS.SENT, id: file.id, hash: file.hash, at: now, delivered: true, sameAs: twin }
  }
}

function markNoted(state, files, now) {
  for (const file of files) {
    const previous = findRecord(state, file)
    state.files[file.path] = { status: STATUS.NOTED, id: file.id, hash: file.hash, at: now, delivered: Boolean(previous?.delivered) }
  }
}

function deliverContext(state, dir, items, covered, runtime, now, callHash, epochBudget) {
  const entries = items.map(({ file, cls }) => ({ ...file, changed: cls === CLASS.CHANGED }))
  const packed = packContext(dir, entries, BUDGET[runtime], covered.map(({ file, twin }) => ({ path: file.path, twin })), { epochBudget })
  const capped = packed.capped ?? []
  const referenced = covered.filter(({ file }) => !packed.covered || packed.covered.includes(file.path))
  markDelivered(state, entries.filter(file => packed.sent.includes(file.path) || capped.includes(file.path)), now, callHash, capped)
  markNoted(state, entries.filter(file => packed.noted.includes(file.path)), now)
  markCovered(state, referenced, now)
  return { decision: DECISION.CONTEXT, text: packed.text, accounting: packed.accounting, sent: packed.sent, noted: packed.noted, capped, covered: referenced.map(({ file }) => file.path) }
}

function decide(runtime, { event, state, chain, dir, targets, selves, now, callHash, epochBudget, observations }) {
  const excluded = applySelfTargets(state, selves, now)
  const twins = deliveredTwins(runtime, state, now)
  const items = chain.filter(file => !excluded.has(file.path)).map(file => {
    const record = findRecord(state, file)
    let cls = classify(runtime, record, file, now, callHash)
    if ((cls === CLASS.SEEN || cls === CLASS.STALE) && Number.isFinite(record?.at)) observations.ageMs = Math.max(observations.ageMs ?? 0, now - record.at)
    if (cls === CLASS.ACCEPT) Object.assign(record, { hash: file.hash, selfWrite: false })
    // Only never-seen files can be covered; twins come from earlier calls, never this one
    const twin = cls === CLASS.NEW ? twins.get(file.hash) : undefined
    if (twin) cls = CLASS.COVERED
    return { file, cls, twin, reason: cls === CLASS.NEW && state.priorEpoch.includes(file.path) ? 'after-reset' : cls }
  })
  const covered = items.filter(({ cls }) => cls === CLASS.COVERED)
  if (covered.length) observations.coveredBytes = Object.fromEntries(covered.map(({ file }) => [file.path, Buffer.byteLength(file.text)]))
  const base = { candidates: targets ? targets.paths.length : 1, kind: targets?.kind ?? null, reasons: {}, capped: [] }
  if (targets?.kind === KIND.WRITE && items.some(({ cls }) => BOUNCE_CLASSES.has(cls))) {
    const bounced = items.filter(({ cls }) => !QUIET_CLASSES.has(cls))
    const reason = bounceReason(dir, bounced.map(({ file }) => file), BUDGET.bounce, covered.map(({ file, twin }) => ({ path: file.path, twin })), { epochBudget })
    const deferred = bounced.filter(({ file }) => reason.deferred?.includes(file.path))
    const referenced = covered.filter(({ file }) => !reason.covered || reason.covered.includes(file.path))
    markDelivered(state, bounced.filter(item => !deferred.includes(item)).map(({ file }) => file), now, callHash, reason.capped)
    markNoted(state, deferred.map(({ file }) => file), now)
    markCovered(state, referenced, now)
    return { ...base, decision: DECISION.BOUNCE, text: reason.text, accounting: reason.accounting, bounced: bounced.map(({ file }) => file.path), covered: referenced.map(({ file }) => file.path), capped: reason.capped ?? [], reasons: Object.fromEntries(bounced.map(item => [item.file.path, item.reason])) }
  }
  const allowed = event === EVENT.PRE && targets.kind === KIND.WRITE ? RESEND_CLASSES : READ_CLASSES
  const pending = items.filter(({ cls }) => allowed.has(cls))
  if (!pending.length && !covered.length) return { ...base, decision: DECISION.NONE }
  return { ...base, ...deliverContext(state, dir, pending, covered, runtime, now, callHash, epochBudget), reasons: Object.fromEntries(pending.map(item => [item.file.path, item.reason])) }
}

function contextOutput(event, text) {
  return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) }
}

async function appendLog(root, entry) {
  await secureDirectory(root)
  const path = join(root, LOG_FILE)
  const openLog = async () => {
    const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw failure('STATE_FILE_UNSAFE')
      return { handle, size: info.size }
    } catch (error) { await handle.close(); throw error }
  }
  let log = await openLog()
  try {
    if (log.size > LOG_LIMIT_BYTES) {
      await log.handle.close()
      log = null
      await rename(path, `${path}.1`)
      log = await openLog()
    }
    await log.handle.writeFile(`${JSON.stringify(entry)}\n`)
  } finally { await log?.handle.close() }
}

async function pruneSessions(root, keep, now) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === keep) continue
    try {
      if (now - (await stat(join(root, entry.name, STATE_FILE))).mtimeMs > PRUNE_MS) await rm(join(root, entry.name), { recursive: true, force: true })
    } catch { /* a session without state is left alone */ }
  }
}

export async function handleAgentsChain(runtime, payload, { root = defaultRoot(), env = process.env, home = homedir(), trusted, now = Date.now, epochBytesCap = EPOCH_BYTES_CAP, instrumentation = instrumentDecision, deadlineMs = DEADLINE_MS } = {}) {
  if (env.AGENTS_CHAIN_DISABLE === '1' || !validIdentity(runtime, payload)) return quiet()
  const event = payload.hook_event_name
  const observations = {}
  let targets
  try { targets = event === EVENT.PRE ? toolTargets(payload, { observations }) : null } catch { return quiet() }
  // Quiet shell calls still carry parse coverage; unrelated tools skip logging
  if (targets && (targets.kind === KIND.NONE || !targets.paths.length) && !isShellCall(payload)) return quiet()
  const started = Date.now()
  const mode = env.AGENTS_CHAIN_MODE === MODE.LOG ? MODE.LOG : MODE.LIVE
  const time = now()
  const agentId = payload.agent_id ? String(payload.agent_id) : null
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null
  const callHash = digest(JSON.stringify([payload.tool_name ?? null, payload.tool_input ?? null])).slice(0, 16)
  const entry = {
    ts: new Date(time).toISOString(), runtime, session: digest(`${runtime}\0${payload.session_id}`).slice(0, 12),
    agent: agentId ? digest(agentId).slice(0, 12) : null, toolUseId: payload.tool_use_id ?? null,
    event, tool: payload.tool_name ?? null, source: sourceToken(event, payload.source), kind: targets?.kind ?? null, candidates: targets?.paths.length ?? (cwd ? 1 : 0),
    sent: [], noted: [], covered: [], bounced: [], bytes: 0, decision: DECISION.NONE, mode, ms: 0, reasons: {}, capped: [], epochBytes: 0,
  }
  const timing = { lockWaitMs: 0 }
  const addInstrumentation = (result, bounces) => {
    if (!instrumentation) return null
    try {
      const extra = instrumentation({ runtime, env, mode, decision: result.decision, delivery: result, covered: result.covered ?? [], callHash, now: time, bounces, observations, ver: HOOK_VERSION, schema: SCHEMA_VERSION, lockWaitMs: timing.lockWaitMs })
      result.telemetry = extra.fields
      return extra.bounces
    } catch { result.telemetry = { instrumentError: 'COLLECT' }; return null }
  }
  try {
    const store = new Store(`agents-chain:${storeKey(runtime, payload.session_id, agentId, mode)}`, root)
    await store.prepare()
    if (event === EVENT.START) await pruneSessions(root, store.id, time).catch(() => {})
    const path = join(store.dir, STATE_FILE)
    // Outside the lock: chains, native sets and worktree lookups; the snapshot only
    // supplies the start directory and cached worktree answers
    let snapshot = null
    try { snapshot = await loadState(path) } catch { snapshot = null }
    const worktrees = { ...(snapshot?.worktrees ?? {}) }
    const options = await chainOptions({ home, trusted, env, runtime, worktree: cachedWorktree(worktrees), observations })
    const reset = event === EVENT.START && payload.source !== SOURCE.RESUME
    let startCwd = snapshot?.startCwd ?? null
    if (event === EVENT.START && (payload.source === SOURCE.STARTUP || !startCwd)) startCwd = cwd
    if (!startCwd) startCwd = (agentId ? await mainStartCwd(root, runtime, payload, mode) : null) ?? cwd
    const natives = reset || !snapshot || (event === EVENT.START && runtime === 'codex') ? (startCwd ? await nativeFiles(runtime, startCwd, options) : []) : null
    const chain = event === EVENT.START ? (cwd ? await chainFor([cwd], options) : []) : await chainFor(targets.paths, options)
    const selves = targets ? await selfTargets(payload, targets) : []
    const labelSource = event === EVENT.START ? cwd : targets.paths.length === 1 ? targets.paths[0] : null
    const dir = labelSource ? await realDirectory(labelSource) : ''
    if (Date.now() - started > deadlineMs) throw failure('DEADLINE')
    const result = await withLock(store.dir, async () => {
      const previous = await loadState(path)
      let state = reset ? null : previous
      const created = !state
      state ??= freshState(startCwd, natives ?? (startCwd ? await nativeFiles(runtime, startCwd, options) : []), time, previous)
      mergeWorktrees(state, worktrees)
      const before = JSON.stringify(state)
      if (Date.now() - started > deadlineMs) throw failure('DEADLINE')
      if (!Number.isSafeInteger(epochBytesCap) || epochBytesCap < 0) throw failure('CAP_INVALID')
      const outcome = decide(runtime, { event, state, chain, dir, targets, selves, now: time, callHash, epochBudget: Math.max(0, epochBytesCap - state.epochBytes), observations })
      state.epochBytes += outcome.text ? Buffer.byteLength(outcome.text) : 0
      outcome.epochBytes = state.epochBytes
      const bounces = addInstrumentation(outcome, state.bounces)
      if (bounces && Object.keys(bounces).length) state.bounces = bounces
      else if (bounces && state.bounces) delete state.bounces
      // A new state is always written so later calls find the start directory
      if (created || JSON.stringify(state) !== before) await atomicJson(path, state)
      return outcome
    }, timing)
    Object.assign(entry, {
      sent: result.sent ?? [], noted: result.noted ?? [], covered: result.covered ?? [], bounced: result.bounced ?? [],
      bytes: result.text ? Buffer.byteLength(result.text) : 0, decision: result.decision, ms: Date.now() - started,
      reasons: result.reasons, capped: result.capped, epochBytes: result.epochBytes,
      ...result.telemetry,
    })
    await appendLog(root, entry).catch(() => {})
    if (mode === MODE.LOG || result.decision === DECISION.NONE) return quiet()
    if (result.decision === DECISION.BOUNCE) return { exitCode: BLOCK_EXIT_CODE, stderr: result.text }
    return contextOutput(event, result.text)
  } catch (error) {
    entry.error = error?.code ?? error?.name ?? 'Error'
    const failed = { decision: DECISION.NONE }
    addInstrumentation(failed)
    Object.assign(entry, failed.telemetry)
    if (error?.code === 'DEADLINE') entry.deadlineHit = true
    entry.ms = Date.now() - started
    await appendLog(root, entry).catch(() => {})
    return quiet()
  }
}

const LOG_ONLY_FLAG = '--log-only'

export async function runAgentsChainHook(runtime, args = []) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`Usage: agents-chain-${runtime} [--log-only]\n\nReads one ${runtime} SessionStart or PreToolUse JSON payload on stdin.\n--log-only projects delivery without returning context or blocking tools.\n-h, --help shows this message without reading stdin.\nAGENTS_CHAIN_MODE=log projects delivery; AGENTS_CHAIN_DISABLE=1 disables it.\nAGENTS_CHAIN_EXCLUDED_ROOTS is an optional JSON array of absolute paths.\nXDG_STATE_HOME selects owner-only state (default: $HOME/.local/state).\nRequires Node.js 22+ and Git for worktree ancestry.\nExit 0: allow/context or internal fail-open; exit 2: intentional first-write block.\n`)
    return
  }
  const env = args.includes(LOG_ONLY_FLAG) ? { ...process.env, AGENTS_CHAIN_MODE: MODE.LOG } : process.env
  try {
    let input = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) {
      input += chunk
      if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
        await appendLog(defaultRoot(env), { ts: new Date().toISOString(), runtime, event: null, decision: DECISION.NONE, error: 'INPUT_LIMIT', bytes: 0, reasons: {}, capped: [], epochBytes: 0, ver: HOOK_VERSION, schema: SCHEMA_VERSION, lockWaitMs: 0, mode: env.AGENTS_CHAIN_MODE === MODE.LOG ? MODE.LOG : MODE.LIVE }).catch(() => {})
        return
      }
    }
    const result = await handleAgentsChain(runtime, JSON.parse(input), { env })
    if (result.stdout) process.stdout.write(`${result.stdout}\n`)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exitCode = result.exitCode
  } catch {
    process.exitCode = 0
  }
}
