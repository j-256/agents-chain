// Read explicitly selected transcripts without collecting prompts or changing runtime files
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { excludedRoots } from './policy.mjs'

const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_LINE_BYTES = 1024 * 1024
const METRICS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']
const CODEX_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']

const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const integer = value => Number.isSafeInteger(value) && value >= 0
const emptyMetrics = () => Object.fromEntries(METRICS.map(key => [key, null]))
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
const digest = (runtime, id) => createHash('sha256').update(`${runtime}\0${id}`).digest('hex').slice(0, 12)
const sensitive = (path, roots) => roots.some(root => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
const fail = code => Object.assign(new Error(code), { code })

function counter(value) {
  if (value === undefined || value === null) return null
  if (!integer(value)) throw fail('INVALID_COUNTER')
  return value
}

function sum(values) {
  if (values.some(value => value === null)) return null
  const total = values.reduce((a, b) => a + b, 0)
  if (!integer(total)) throw fail('INVALID_COUNTER')
  return total
}

function normalizeCodex(usage) {
  const result = Object.fromEntries(METRICS.map((key, i) => [key, counter(usage[CODEX_FIELDS[i]])]))
  if (result.inputTokens !== null && result.outputTokens !== null) {
    const total = sum([result.inputTokens, result.outputTokens])
    if (result.totalTokens !== null && result.totalTokens !== total) throw fail('INVALID_COUNTER')
    result.totalTokens = total
  }
  if (result.cachedInputTokens !== null && result.inputTokens !== null && result.cachedInputTokens > result.inputTokens) throw fail('INVALID_COUNTER')
  if (result.reasoningOutputTokens !== null && result.outputTokens !== null && result.reasoningOutputTokens > result.outputTokens) throw fail('INVALID_COUNTER')
  return result
}

function normalizeClaude(usage) {
  const fresh = counter(usage.input_tokens)
  const cached = counter(usage.cache_read_input_tokens)
  const written = counter(usage.cache_creation_input_tokens)
  const output = counter(usage.output_tokens)
  const input = sum([fresh, cached, written])
  const reasoning = counter(usage.output_tokens_details?.thinking_tokens)
  if (reasoning !== null && output !== null && reasoning > output) throw fail('INVALID_COUNTER')
  return { inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: written, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: sum([input, output]) }
}

function finish(session, since) {
  let metrics = emptyMetrics()
  let requests = null
  if (session.runtime === 'codex') {
    const snapshots = session.snapshots.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    const previous = emptyMetrics()
    for (const snapshot of snapshots) {
      for (const key of METRICS) {
        if (snapshot.metrics[key] === null) continue
        if (previous[key] !== null && snapshot.metrics[key] < previous[key]) session.issues.add('COUNTER_RESET')
        previous[key] = snapshot.metrics[key]
      }
    }
    const undated = since !== null && snapshots.some(s => s.at === null)
    if (undated) session.issues.add('MISSING_TIMESTAMP')
    const current = since === null ? snapshots.at(-1) : snapshots.filter(s => s.at !== null && s.at >= since).at(-1)
    if (!current && !undated) return null
    const baseline = since === null ? null : snapshots.filter(s => s.at !== null && s.at < since).at(-1)
    if (since !== null && !baseline && (session.startedAt === null || session.startedAt < since)) session.issues.add('MISSING_BASELINE')
    if (current && ![...session.issues].some(issue => ['COUNTER_RESET', 'MISSING_BASELINE', 'MISSING_TIMESTAMP', 'INVALID_COUNTER'].includes(issue))) {
      metrics = Object.fromEntries(METRICS.map(key => [key, current.metrics[key] === null || (baseline && baseline.metrics[key] === null) ? null : current.metrics[key] - (baseline?.metrics[key] ?? 0)]))
    }
  } else {
    const undated = since !== null && [...session.requests.values()].some(r => r.at === null || r.undated)
    if (undated) session.issues.add('MISSING_TIMESTAMP')
    const selected = [...session.requests.values()].filter(r => since === null || (r.at !== null && r.at >= since))
    if (!selected.length && !undated && !session.issues.has('MISSING_USAGE_ID')) return null
    requests = undated || session.issues.has('MISSING_USAGE_ID') ? null : selected.length
    if (!session.issues.has('INVALID_COUNTER') && !session.issues.has('MISSING_TIMESTAMP') && !session.issues.has('MISSING_USAGE_ID')) {
      try { metrics = Object.fromEntries(METRICS.map(key => [key, sum(selected.map(r => r.metrics[key]))])) }
      catch { session.issues.add('INVALID_COUNTER') }
    }
  }
  return { runtime: session.runtime, session: session.session, models: [...session.models].sort(), requests, ...metrics, status: session.issues.size || metrics.inputTokens === null || metrics.outputTokens === null ? 'partial' : 'measured', issues: [...session.issues].sort() }
}

export async function readRuntimeUsage(files, { since = null } = {}) {
  const configured = excludedRoots()
  const roots = [...configured, ...await Promise.all(configured.map(root => realpath(root).catch(() => root)))]
  const cutoff = since === null ? null : Date.parse(since)
  if (cutoff !== null && !Number.isFinite(cutoff)) throw fail('INVALID_SINCE')
  const coverage = { filesRead: 0, duplicateFiles: 0, unavailableFiles: 0, unsupportedFiles: 0, malformed: 0, oversizedLines: 0, invalidUsage: 0, usageRecords: 0, since, fileLimitBytes: MAX_FILE_BYTES, lineLimitBytes: MAX_LINE_BYTES }
  const sessions = new Map()
  const seen = new Set()
  const sources = []
  const getSession = (runtime, id) => {
    const key = digest(runtime, id)
    if (!sessions.has(key)) sessions.set(key, { runtime, session: key, startedAt: null, models: new Set(), snapshots: [], requests: new Map(), issues: new Set() })
    return sessions.get(key)
  }
  for (const [index, file] of files.entries()) {
    const source = { index, status: 'unavailable' }
    sources.push(source)
    let handle
    let lines
    let stream
    const touched = new Set()
    let localMalformed = 0
    let codexId = null
    try {
      const path = resolve(file)
      if (sensitive(path, roots)) throw fail('SENSITIVE_PATH')
      const link = await lstat(path)
      if (link.isSymbolicLink() && sensitive(resolve(dirname(path), await readlink(path)), roots)) throw fail('SENSITIVE_PATH')
      const canonical = await realpath(path)
      if (sensitive(canonical, roots)) throw fail('SENSITIVE_PATH')
      if (seen.has(canonical)) { source.status = 'duplicate'; coverage.duplicateFiles += 1; continue }
      handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = await handle.stat()
      if (!info.isFile()) throw fail('NOT_REGULAR_FILE')
      if (info.size > MAX_FILE_BYTES) throw fail('FILE_LIMIT')
      seen.add(canonical)
      if (!info.size) { source.status = 'unsupported'; coverage.filesRead += 1; coverage.unsupportedFiles += 1; continue }
      stream = handle.createReadStream({ encoding: 'utf8', autoClose: false, end: info.size - 1 })
      lines = createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of lines) {
        if (!line.trim()) continue
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) { coverage.oversizedLines += 1; localMalformed += 1; continue }
        let row
        try { row = JSON.parse(line) } catch { coverage.malformed += 1; localMalformed += 1; continue }
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue
        if (row.type === 'session_meta' && validId(row.payload?.id ?? row.payload?.session_id)) {
          codexId = row.payload.id ?? row.payload.session_id
          const session = getSession('codex', codexId)
          const start = timestamp(row.payload.timestamp ?? row.timestamp)
          if (start !== null) session.startedAt = session.startedAt === null ? start : Math.min(start, session.startedAt)
          continue
        }
        if (row.type === 'turn_context' && codexId && MODEL.test(row.payload?.model ?? '')) getSession('codex', codexId).models.add(row.payload.model)
        let session
        try {
          if (row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.info?.total_token_usage && codexId) {
            session = getSession('codex', codexId)
            session.snapshots.push({ at: timestamp(row.timestamp), metrics: normalizeCodex(row.payload.info.total_token_usage) })
          } else if (row.type === 'assistant' && row.message?.usage) {
            const id = row.sessionId ?? row.session_id
            const request = row.requestId ?? row.message.id
            if (!validId(id)) throw fail('MISSING_USAGE_ID')
            session = getSession('claude', id)
            if (!validId(request)) throw fail('MISSING_USAGE_ID')
            const usage = normalizeClaude(row.message.usage)
            const previous = session.requests.get(request)
            const metrics = previous ? Object.fromEntries(METRICS.map(key => [key, usage[key] === null ? previous.metrics[key] : previous.metrics[key] === null ? usage[key] : Math.max(usage[key], previous.metrics[key])])) : usage
            const at = timestamp(row.timestamp)
            const firstAt = previous?.at === null || previous?.at === undefined ? at : at === null ? previous.at : Math.min(previous.at, at)
            session.requests.set(request, { at: firstAt, undated: Boolean(previous?.undated || at === null), metrics })
            if (MODEL.test(row.message.model ?? '')) session.models.add(row.message.model)
          } else continue
          touched.add(session)
          coverage.usageRecords += 1
        } catch (error) {
          coverage.invalidUsage += 1
          if (session) { session.issues.add(error.code ?? 'INVALID_COUNTER'); touched.add(session) }
        }
      }
      coverage.filesRead += 1
      if (!touched.size) { source.status = 'unsupported'; coverage.unsupportedFiles += 1 }
      else source.status = 'read'
      if (localMalformed) for (const session of touched) session.issues.add('INCOMPLETE_SOURCE')
    } catch (error) {
      coverage.unavailableFiles += 1
      source.error = /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'READ_ERROR'
      for (const session of touched) session.issues.add('INCOMPLETE_SOURCE')
    } finally {
      lines?.close()
      stream?.destroy()
      await handle?.close().catch(() => {})
    }
  }
  return { scope: 'available runtime usage; not incremental hook cost', coverage, sources, sessions: [...sessions.values()].map(s => finish(s, cutoff)).filter(Boolean) }
}

export function formatRuntimeUsage(usage) {
  const lines = [`Runtime usage (${usage.scope}): ${JSON.stringify(usage.coverage)}`]
  for (const session of usage.sessions) lines.push(`${session.runtime} session ${session.session}: input ${session.inputTokens ?? 'unknown'}, cached ${session.cachedInputTokens ?? 'unknown'}, cache writes ${session.cacheWriteInputTokens ?? 'unknown'}, output ${session.outputTokens ?? 'unknown'}, total ${session.totalTokens ?? 'unknown'}; ${session.status}${session.issues.length ? ` (${session.issues.join(', ')})` : ''}`)
  for (const source of usage.sources) if (source.error || source.status === 'unsupported') lines.push(`Usage source ${source.index + 1}: ${source.error ?? source.status}`)
  return `${lines.join('\n')}\n`
}
