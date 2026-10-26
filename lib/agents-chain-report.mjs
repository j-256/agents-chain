// Summarize retained log evidence without reading session state or changing files
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { estimateTokens, TOKEN_ESTIMATE_METHOD } from './agents-chain-instrument.mjs'

const RUNTIMES = new Set(['claude', 'codex'])
const MODES = new Set(['log', 'live'])
const DECISIONS = new Set(['none', 'context', 'bounce'])
const REASONS = new Set(['new', 'changed', 'stale', 'noted', 'recent', 'after-reset'])
const EXCLUSIONS = new Set(['outside-home', 'not-user-owned', 'symlink-name', 'skipped-directory', 'empty-or-non-utf8', 'global-file'])
const TOKEN = /^[a-zA-Z0-9_-]{1,64}$/
const WORST_EPOCH_LIMIT = 5
const HOUR_MINUTES = 60
const STALE_MINUTES = 4 * HOUR_MINUTES
const PART_KINDS = new Set(['full', 'outline', 'note', 'covered', 'wrapper'])
const PART_REASONS = new Set([...REASONS, 'covered', 'wrapper', 'unknown'])
const integer = value => Number.isSafeInteger(value) && value >= 0
const increment = (counts, key, n = 1) => { counts[key] = (Object.hasOwn(counts, key) ? counts[key] : 0) + n }

function distribution(values) {
  const sorted = values.sort((a, b) => a - b)
  const n = sorted.length
  return { samples: n, median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2 : null, p95: n ? sorted[Math.ceil(n * 0.95) - 1] : null, max: n ? sorted[n - 1] : null }
}

function createGroup(runtime, mode) {
  return {
    runtime, mode, sessions: new Set(), calls: 0, deliveries: 0, bytes: 0,
    reasons: {}, capped: 0, bounces: 0, sources: {}, excluded: {}, savedBytes: 0,
    native: { samples: 0, bytes: 0, maxBytes: null, overflowCalls: 0, overflowFiles: 0 },
    shell: { measuredCalls: 0, missCalls: 0, unresolved: 0, missRate: null },
    errors: {}, instrumentErrors: {}, deadlineHits: 0, versions: {}, runtimeVersions: {},
    measured: { reasons: 0, capped: 0, savedBytes: 0, excluded: 0 },
    tokenParts: { attributedCalls: 0, unattributedBytes: 0, byKind: {}, byReason: {}, files: new Map() }, sessionBytes: new Map(), tokenDeliveryValues: [],
    retryValues: [], ageValues: [], timingValues: [], lockValues: [], epochList: [], activeEpochs: new Map(),
  }
}

function addRecord(group, row) {
  group.calls += 1
  if (row.session) group.sessions.add(row.session)
  if (row.decision !== 'none' && row.bytes > 0) {
    group.deliveries += 1
    group.tokenDeliveryValues.push(estimateTokens(row.bytes))
  }
  group.bytes += row.bytes
  if (row.session) group.sessionBytes.set(row.session, (group.sessionBytes.get(row.session) ?? 0) + row.bytes)
  const parts = row.tokens?.parts
  const validParts = row.tokens?.method === TOKEN_ESTIMATE_METHOD && row.tokens.estimate === estimateTokens(row.bytes) && Array.isArray(parts) && parts.every(p => p && PART_KINDS.has(p.kind) && PART_REASONS.has(p.reason) && integer(p.bytes) && (p.kind === 'wrapper' ? p.path === null : typeof p.path === 'string' && p.path.length > 0)) && parts.reduce((sum, p) => sum + p.bytes, 0) === row.bytes
  if (validParts) {
    group.tokenParts.attributedCalls += 1
    for (const part of parts) {
      increment(group.tokenParts.byKind, part.kind, part.bytes)
      increment(group.tokenParts.byReason, part.reason, part.bytes)
      if (part.path) group.tokenParts.files.set(part.path, (group.tokenParts.files.get(part.path) ?? 0) + part.bytes)
    }
  } else group.tokenParts.unattributedBytes += row.bytes
  const key = JSON.stringify([row.session ?? null, row.agent ?? null])
  const start = row.event === 'SessionStart' && !row.error
  const knownSource = typeof row.source === 'string' && TOKEN.test(row.source)
  const reset = start && knownSource && row.source !== 'resume'
  let epoch = group.activeEpochs.get(key)
  if (!epoch || reset) {
    if (epoch) epoch.openEnd = false
    epoch = { session: row.session ?? null, agent: row.agent ?? null, start: row.ts, bytes: 0, partialStart: !reset, openEnd: true, uncertainBoundary: false }
    group.epochList.push(epoch)
    group.activeEpochs.set(key, epoch)
  }
  epoch.bytes += row.bytes
  if (start && !knownSource) epoch.uncertainBoundary = true
  if (row.event === 'SessionStart') increment(group.sources, TOKEN.test(row.source ?? '') ? row.source : 'unknown')
  if (row.reasons && typeof row.reasons === 'object' && !Array.isArray(row.reasons)) {
    group.measured.reasons += 1
    for (const reason of Object.values(row.reasons)) if (REASONS.has(reason)) increment(group.reasons, reason)
  }
  if (Array.isArray(row.capped)) { group.measured.capped += 1; group.capped += row.capped.length }
  if (row.decision === 'bounce') group.bounces += 1
  for (const [name, target] of [['retryOfMs', 'retryValues'], ['ageMin', 'ageValues'], ['ms', 'timingValues'], ['lockWaitMs', 'lockValues']]) {
    if (integer(row[name])) group[target].push(row[name])
  }
  if (integer(row.nativeBytes)) {
    group.native.samples += 1
    group.native.bytes += row.nativeBytes
    group.native.maxBytes = Math.max(group.native.maxBytes ?? 0, row.nativeBytes)
    const overflow = Array.isArray(row.nativeOverflow) ? row.nativeOverflow.length : 0
    group.native.overflowFiles += overflow
    if (overflow) group.native.overflowCalls += 1
  }
  if (row.excluded && typeof row.excluded === 'object') {
    group.measured.excluded += 1
    for (const [reason, count] of Object.entries(row.excluded)) if (EXCLUSIONS.has(reason) && integer(count)) increment(group.excluded, reason, count)
  }
  if (integer(row.unresolved)) {
    group.shell.measuredCalls += 1
    group.shell.unresolved += row.unresolved
    if (row.unresolved) group.shell.missCalls += 1
  }
  if (integer(row.savedBytes)) { group.measured.savedBytes += 1; group.savedBytes += row.savedBytes }
  if (row.error) increment(group.errors, TOKEN.test(row.error) ? row.error : 'other')
  if (row.instrumentError) increment(group.instrumentErrors, TOKEN.test(row.instrumentError) ? row.instrumentError : 'other')
  if (row.deadlineHit === true) group.deadlineHits += 1
  if (integer(row.ver)) increment(group.versions, String(row.ver))
  if (typeof row.runtimeVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(row.runtimeVersion)) increment(group.runtimeVersions, row.runtimeVersion)
}

function finishGroup(group) {
  const { retryValues, ageValues, timingValues, lockValues, epochList, activeEpochs, tokenParts, sessionBytes, tokenDeliveryValues, ...summary } = group
  summary.sessions = group.sessions.size
  summary.epochs = epochList.length
  summary.uncertainEpochs = epochList.filter(epoch => epoch.uncertainBoundary).length
  summary.worstEpochs = epochList.sort((a, b) => b.bytes - a.bytes).slice(0, WORST_EPOCH_LIMIT)
  const estimatedMap = values => Object.fromEntries(Object.entries(values).map(([key, bytes]) => [key, estimateTokens(bytes)]))
  summary.tokens = {
    method: TOKEN_ESTIMATE_METHOD, estimate: estimateTokens(group.bytes),
    scope: group.mode === 'log' ? 'projected hook output' : group.mode === 'live' ? 'emitted hook output' : 'hook output with unknown mode',
    perDelivery: distribution(tokenDeliveryValues),
    perEpoch: distribution(epochList.map(e => estimateTokens(e.bytes))),
    perSession: distribution([...sessionBytes.values()].map(estimateTokens)),
    attributedCalls: tokenParts.attributedCalls, unattributedBytes: tokenParts.unattributedBytes,
    byKind: estimatedMap(tokenParts.byKind), byReason: estimatedMap(tokenParts.byReason),
    topFiles: [...tokenParts.files].sort((a, b) => b[1] - a[1]).slice(0, WORST_EPOCH_LIMIT).map(([path, bytes]) => ({ path, bytes, estimate: estimateTokens(bytes) })),
  }
  summary.retries = distribution(retryValues)
  summary.ages = {
    ...distribution(ageValues),
    under60: ageValues.filter(n => n < HOUR_MINUTES).length,
    from60To239: ageValues.filter(n => n >= HOUR_MINUTES && n < STALE_MINUTES).length,
    atOrOver240: ageValues.filter(n => n >= STALE_MINUTES).length,
  }
  summary.timings = distribution(timingValues)
  summary.lockWait = distribution(lockValues)
  summary.shell.missRate = summary.shell.measuredCalls ? summary.shell.missCalls / summary.shell.measuredCalls : null
  return summary
}

export async function readReport(files, { since = null, allowMissing = false } = {}) {
  const coverage = { filesRead: 0, missingFiles: 0, lines: 0, malformed: 0, filtered: 0, since, epochScope: 'Observed records only; retained or filtered edges can contain partial epochs, final epochs remain open, and unknown-source starts can span uncertain boundaries' }
  const records = []
  for (const path of files) {
    const input = createReadStream(path, { encoding: 'utf8' })
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (!line.trim()) continue
        coverage.lines += 1
        let row
        try { row = JSON.parse(line) } catch { coverage.malformed += 1; continue }
        if (!row || !RUNTIMES.has(row.runtime) || !DECISIONS.has(row.decision) || !Number.isFinite(Date.parse(row.ts)) || !integer(row.bytes ?? 0) || (row.session != null && !TOKEN.test(row.session)) || (row.agent != null && !TOKEN.test(row.agent))) {
          coverage.malformed += 1
          continue
        }
        if (since && Date.parse(row.ts) < Date.parse(since)) { coverage.filtered += 1; continue }
        records.push({ ...row, bytes: row.bytes ?? 0, mode: MODES.has(row.mode) ? row.mode : 'unknown' })
      }
      coverage.filesRead += 1
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') coverage.missingFiles += 1
      else throw error
    } finally { lines.close(); input.destroy() }
  }
  const groups = new Map()
  for (const row of records.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    const key = `${row.runtime}:${row.mode}`
    if (!groups.has(key)) groups.set(key, createGroup(row.runtime, row.mode))
    addRecord(groups.get(key), row)
  }
  return { coverage, groups: [...groups.values()].map(finishGroup).sort((a, b) => `${a.runtime}:${a.mode}`.localeCompare(`${b.runtime}:${b.mode}`)) }
}

const shown = value => JSON.stringify(value)

export function formatReport(report) {
  const lines = [`Retained log coverage: ${report.coverage.filesRead} files, ${report.coverage.lines} records, ${report.coverage.malformed} malformed, ${report.coverage.filtered} filtered`, report.coverage.epochScope]
  for (const group of report.groups) {
    lines.push('', `${group.runtime} (${group.mode})`,
      `Sessions ${group.sessions}; calls ${group.calls}; deliveries ${group.deliveries}; bytes ${group.bytes}; epochs ${group.epochs} (${group.uncertainEpochs} uncertain)`,
      `Estimated tokens (${group.tokens.method}, ${group.tokens.scope}): ${group.tokens.estimate}; per reset ${shown(group.tokens.perEpoch)}; per session ${shown(group.tokens.perSession)}`,
      `Estimated tokens per delivery: ${shown(group.tokens.perDelivery)}; attribution measured on ${group.tokens.attributedCalls} calls`,
      `Token attribution: kinds ${shown(group.tokens.byKind)}; reasons ${shown(group.tokens.byReason)}; unattributed bytes ${group.tokens.unattributedBytes}; top files ${shown(group.tokens.topFiles)}`,
      `Worst epochs (observed bytes): ${shown(group.worstEpochs)}`,
      `Reasons ${shown(group.reasons)}; capped files ${group.capped}; bounces ${group.bounces}`,
      `Retries in ms ${shown(group.retries)}; SessionStart sources ${shown(group.sources)}`,
      `Ages in minutes (four-hour threshold at 240) ${shown(group.ages)}`,
      `Native ${shown(group.native)}; saved bytes ${group.savedBytes}`,
      `Exclusions ${shown(group.excluded)}; Parse misses ${shown(group.shell)}`,
      `Hook duration in ms ${shown(group.timings)}; lock wait in ms ${shown(group.lockWait)}`,
      `Errors ${shown(group.errors)}; telemetry errors ${shown(group.instrumentErrors)}; deadlines ${group.deadlineHits}`,
      `Measured fields ${shown(group.measured)}; hook versions ${shown(group.versions)}; runtime versions ${shown(group.runtimeVersions)}`)
  }
  if (!report.groups.length) lines.push('No matching records')
  return `${lines.join('\n')}\n`
}
