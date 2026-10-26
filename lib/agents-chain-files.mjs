// Find the AGENTS.md files that govern a directory, map a linked worktree to its
// main checkout, and compute which files each runtime loaded natively
// Files are identified by device and inode so hardlinked copies count once
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { excludedRoots } from './policy.mjs'

const runFile = promisify(execFile)
const FILE_NAME = 'AGENTS.md'
const ROOT_MARKER = '.git'
const GIT_TIMEOUT_MS = 2000
// Codex joins project files root first and truncates the total at this many bytes
export const CODEX_PROJECT_BUDGET = 32768
const UNTRUSTED_SEGMENTS = new Set(['node_modules', '.git'])
const MISSING = new Set(['ENOENT', 'ENOTDIR'])
const GIT_ENV_OVERRIDES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']
const decoder = new TextDecoder('utf-8', { fatal: true })

async function realOrSelf(path) {
  try { return await realpath(path) } catch { return path }
}

function importLines(text) {
  let fence = null
  const prose = text.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null
      return ''
    }
    return fence ? '' : line
  }).join('\n')
  return prose.replace(/(`+)[\s\S]*?\1(?!`)/g, span => span.replace(/[^\n]/g, ' ')).split('\n')
}

async function nativeGlobalIdentity({ home, runtime, env }) {
  const codexHome = env.CODEX_HOME || join(home, '.codex')
  const candidates = runtime === 'codex' ? [join(codexHome, 'AGENTS.override.md'), join(codexHome, FILE_NAME)] : runtime === 'claude' ? [join(home, '.claude', 'CLAUDE.md')] : []
  for (const path of candidates) {
    let info
    try { info = await stat(path) } catch { continue }
    if (!info.isFile() || !info.size) continue
    if (runtime === 'claude') {
      const text = await readFile(path, 'utf8')
      for (const line of importLines(text)) {
        const imported = /^\s*@([^\s`]+)/.exec(line)?.[1]
        if (!imported) continue
        const target = imported.startsWith('~/') ? join(home, imported.slice(2)) : resolve(dirname(path), imported)
        if (await realOrSelf(target) !== await realOrSelf(join(home, FILE_NAME))) continue
        try { return await fileIdentity(target) } catch { /* unreadable imports do not suppress delivery */ }
      }
    }
    return fileIdentity(path)
  }
  return null
}

const PREPARED = Symbol('agents-chain options')

// Only files under trusted roots (the home directory by default) are ever delivered,
// minus untrusted subtrees; resolve once per hook call and reuse
export async function chainOptions(options = {}) {
  if (options[PREPARED]) return options
  const { home = homedir(), trusted, untrusted, env = process.env, runtime, worktree = linkedWorktree } = options
  const roots = untrusted ?? excludedRoots(env, home)
  let globalId = null
  try { globalId = await nativeGlobalIdentity({ home, runtime, env }) } catch { /* unconfirmed native globals do not suppress delivery */ }
  return {
    [PREPARED]: true,
    trusted: await Promise.all((trusted ?? [home]).map(realOrSelf)),
    untrusted: await Promise.all(roots.map(realOrSelf)),
    globalId,
    worktree,
    uid: process.getuid?.() ?? null,
    observations: options.observations,
  }
}

function ancestors(dir) {
  const list = []
  let current = dir
  for (;;) {
    list.unshift(current)
    const parent = dirname(current)
    if (parent === current) return list
    current = parent
  }
}

const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

function exclusion(path, options) {
  if (path.split(sep).some(segment => UNTRUSTED_SEGMENTS.has(segment))) return 'skipped-directory'
  if (!options.trusted.some(root => within(path, root))) return 'outside-home'
  return options.untrusted.some(root => within(path, root)) ? 'skipped-directory' : null
}

function countExcluded(options, reason, path) {
  if (!options.observations) return
  const counts = options.observations.excluded ??= {}
  const paths = counts[reason] ??= new Set()
  paths.add(path)
}

export async function fileIdentity(path) {
  const info = await stat(path)
  return `${info.dev}:${info.ino}`
}

export async function realDirectory(path) {
  let current = resolve(path)
  for (;;) {
    try {
      const real = await realpath(current)
      return (await stat(real)).isDirectory() ? real : dirname(real)
    } catch (error) {
      if (!MISSING.has(error.code)) throw error
    }
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

export async function readGoverning(path) {
  let bytes
  try { bytes = await readFile(path) } catch { return null }
  if (!bytes.length) return null
  let text
  try { text = decoder.decode(bytes) } catch { return null }
  return { text, hash: createHash('sha256').update(bytes).digest('hex') }
}

export async function linkedWorktree(dir) {
  const env = { ...process.env }
  for (const name of GIT_ENV_OVERRIDES) delete env[name]
  let stdout
  try {
    ({ stdout } = await runFile('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], { timeout: GIT_TIMEOUT_MS, env }))
  } catch { return null }
  const [gitDir, commonDir, top] = stdout.split('\n')
  if (!gitDir || !commonDir || !top) return null
  const [realGit, realCommon, worktreeTop] = await Promise.all([gitDir, commonDir, top].map(realOrSelf))
  if (realGit === realCommon || basename(realCommon) !== ROOT_MARKER) return null
  return { worktreeTop, mainTop: dirname(realCommon) }
}

export async function mainCheckoutTop(dir) {
  return (await linkedWorktree(await realDirectory(dir)))?.mainTop ?? null
}

// Collect valid, trusted files in directory order, skipping the global file and duplicates
async function collect(dirs, options) {
  const files = []
  const seen = new Set(options.globalId ? [options.globalId] : [])
  for (const dir of dirs) {
    let path
    let id
    try {
      // A symlinked AGENTS.md must resolve to a regular file of that name owned by
      // the user, so a link cannot pull another file into context
      path = await realpath(join(dir, FILE_NAME))
      const info = await stat(path)
      const reason = !info.isFile() ? 'skipped-directory' : basename(path) !== FILE_NAME ? 'symlink-name' : options.uid !== null && info.uid !== options.uid ? 'not-user-owned' : null
      if (reason) { countExcluded(options, reason, path); continue }
      id = `${info.dev}:${info.ino}`
    } catch { continue }
    if (seen.has(id)) {
      if (id === options.globalId) countExcluded(options, 'global-file', path)
      continue
    }
    const reason = exclusion(path, options)
    if (reason) { countExcluded(options, reason, path); continue }
    const content = await readGoverning(path)
    if (!content) { countExcluded(options, 'empty-or-non-utf8', path); continue }
    seen.add(id)
    files.push({ path, id, ...content })
  }
  return files
}

export async function governingFiles(dir, options = {}) {
  const resolved = await chainOptions(options)
  const real = await realDirectory(dir)
  let dirs = ancestors(real)
  // The worktree lookup spawns git, so callers may pass a caching resolver
  const linked = await resolved.worktree(real)
  if (linked) {
    // Main-checkout ancestors above its top level sit between the worktree's outer
    // ancestors and the worktree's own levels
    const split = dirs.indexOf(linked.worktreeTop)
    if (split >= 0) dirs = [...dirs.slice(0, split), ...ancestors(dirname(linked.mainTop)), ...dirs.slice(split)]
  }
  return collect(dirs, resolved)
}

function projectRoot(dir) {
  for (const candidate of ancestors(dir).reverse()) {
    if (existsSync(join(candidate, ROOT_MARKER))) return candidate
  }
  return null
}

export async function nativeFiles(runtime, cwd, options = {}) {
  const resolved = await chainOptions({ ...options, runtime })
  const real = await realDirectory(cwd)
  if (runtime !== 'codex') return collect(ancestors(real), resolved)
  const root = projectRoot(real)
  const files = await collect(root ? ancestors(real).slice(ancestors(root).length - 1) : [real], resolved)
  if (resolved.observations) {
    let bytes = 0
    const overflow = []
    for (const file of files) {
      bytes += Buffer.byteLength(file.text)
      if (bytes > CODEX_PROJECT_BUDGET) overflow.push(file.path)
    }
    Object.assign(resolved.observations, { nativeBytes: bytes, nativeOverflow: overflow })
  }
  const kept = []
  let total = 0
  for (const file of files) {
    total += Buffer.byteLength(file.text)
    if (total > CODEX_PROJECT_BUDGET) break
    kept.push(file)
  }
  return kept
}
