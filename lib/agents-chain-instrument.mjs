// Optional metadata is derived after the decision and never contains source text
const MINUTE_MS = 60 * 1000
const MAX_PENDING_BOUNCES = 16
const VERSION_TOKEN = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/
export const TOKEN_ESTIMATE_METHOD = 'utf8-bytes/4'
export const estimateTokens = bytes => bytes / 4

export function instrumentDecision({ runtime, env, mode, decision, delivery = {}, covered, callHash, now, bounces = {}, observations, ver, schema, lockWaitMs }) {
  const fields = { ver, schema, lockWaitMs }
  const bytes = Buffer.byteLength(delivery.text ?? '')
  const parts = (delivery.accounting?.() ?? (bytes ? [{ path: null, kind: 'wrapper', bytes }] : [])).map(part => ({
    ...part, reason: part.kind === 'wrapper' || part.kind === 'covered' ? part.kind : delivery.reasons?.[part.path] ?? 'unknown',
  }))
  if (parts.reduce((sum, part) => sum + part.bytes, 0) !== bytes) throw new Error('Invalid delivery accounting')
  fields.tokens = { method: TOKEN_ESTIMATE_METHOD, estimate: estimateTokens(bytes), parts }
  if (decision === 'bounce') fields.callHash = callHash
  const pending = Object.fromEntries(Object.entries(bounces).filter(([hash, time]) => /^[a-f0-9]{16}$/.test(hash) && Number.isFinite(time)))
  if (mode === 'live') {
    if (decision === 'bounce') pending[callHash] = now
    else if (Object.hasOwn(pending, callHash)) {
      fields.retryOfMs = Math.max(0, now - pending[callHash])
      delete pending[callHash]
    }
  }
  if (observations.ageMs !== undefined) fields.ageMin = Math.floor(observations.ageMs / MINUTE_MS)
  if (observations.nativeBytes !== undefined) Object.assign(fields, { nativeBytes: observations.nativeBytes, nativeOverflow: observations.nativeOverflow })
  const excluded = Object.fromEntries(Object.entries(observations.excluded ?? {}).map(([reason, paths]) => [reason, paths.size]))
  if (Object.keys(excluded).length) fields.excluded = excluded
  if (observations.unresolved !== undefined) fields.unresolved = observations.unresolved
  if (covered.length) fields.savedBytes = covered.reduce((sum, path) => sum + (observations.coveredBytes?.[path] ?? 0), 0)
  if (runtime === 'codex' && VERSION_TOKEN.test(env.CODEX_VERSION ?? '')) fields.runtimeVersion = env.CODEX_VERSION
  return { fields, bounces: Object.fromEntries(Object.entries(pending).sort((a, b) => a[1] - b[1]).slice(-MAX_PENDING_BOUNCES)) }
}
