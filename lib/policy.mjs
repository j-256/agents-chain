// User-selected exclusions extend the home-directory trust boundary
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const EXCLUDED_NAMES = ['Downloads', '.Trash', '.ssh', '.gnupg', '.aws']

export function excludedRoots(env = process.env, home = homedir()) {
  let extra = []
  try { extra = env.AGENTS_CHAIN_EXCLUDED_ROOTS ? JSON.parse(env.AGENTS_CHAIN_EXCLUDED_ROOTS) : [] }
  catch { throw Object.assign(new Error('Invalid path exclusion configuration'), { code: 'POLICY_INVALID' }) }
  if (!Array.isArray(extra) || extra.some(path => typeof path !== 'string' || !isAbsolute(path))) throw Object.assign(new Error('Exclusions must be absolute paths'), { code: 'POLICY_INVALID' })
  return [...new Set([...EXCLUDED_NAMES.map(name => join(home, name)), ...extra.map(path => resolve(path))])]
}
