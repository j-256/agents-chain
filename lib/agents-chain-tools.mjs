// Classify a hook payload's tool call and find the paths it targets
// Shell parsing is best effort: it keeps tokens that name existing paths, plus
// every target of a file-creating command or output redirect, which may not exist yet
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const KIND = Object.freeze({ READ: 'read', WRITE: 'write', NONE: 'none' })
export const MAX_SHELL_PATHS = 20

const READ_TOOLS = new Map([['Read', 'file_path']])
const WRITE_TOOLS = new Map([['Edit', 'file_path'], ['Write', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']])
const SHELL_TOOLS = new Set(['Bash', 'exec_command'])
const PATCH_TOOL = 'apply_patch'
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/
const SHELL_PATCH = /^\s*apply_patch\b/
// Commands whose arguments may name files that do not exist yet
const CREATING_COMMANDS = new Set(['tee', 'mv', 'cp', 'touch', 'mkdir', 'ln', 'patch', 'chmod', 'rm', 'trash'])
const GIT_WRITES = new Set(['add', 'rm', 'mv', 'commit', 'apply', 'am', 'checkout', 'restore', 'reset', 'merge', 'rebase', 'cherry-pick', 'revert', 'stash', 'clean', 'switch', 'pull', 'worktree', 'init', 'clone'])
const GIT_READ_SUBCOMMANDS = new Map([
  ['worktree', new Set(['list'])],
  ['stash', new Set(['list', 'show'])],
])
const GIT_OUTPUT_OPTION = '--output'
// Words that precede the real command of a segment, including compound-command keywords
const COMMAND_PREFIXES = new Set(['sudo', 'command', 'builtin', 'nohup', 'nice', 'time', 'exec', 'env', 'xargs', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'esac'])
// Segments whose words are loop variables or patterns, not paths
const SKIPPED_COMMANDS = new Set(['for', 'case', 'select', 'function'])
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>'])
const READ_REDIRECT = '<'
const HEREDOC_REDIRECTS = new Set(['<<', '<<-'])
const DEVICE_DIR = '/dev/'
const SEPARATOR = Object.freeze({ type: 'op' })
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const HOME_VARIABLE = /\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g
const PWD_VARIABLE = /\$\{PWD\}|\$PWD(?![A-Za-z0-9_])/g
const UNRESOLVED = /[$`]/

const none = () => ({ kind: KIND.NONE, paths: [] })

function lex(command) {
  const tokens = []
  const delimiters = []
  let awaitingDelimiter = false
  let word = null
  let i = 0
  const flush = () => {
    if (word === null) return
    tokens.push({ type: 'word', value: word })
    if (awaitingDelimiter) delimiters.push(word)
    awaitingDelimiter = false
    word = null
  }
  // Skip heredoc bodies that start on the line after their opener
  const skipBodies = () => {
    let j = i + 1
    for (const delimiter of delimiters) {
      for (;;) {
        if (j >= command.length) return command.length
        const end = command.indexOf('\n', j)
        const stop = end < 0 ? command.length : end
        const line = command.slice(j, stop)
        j = stop + 1
        if (line.replace(/^\t+/, '') === delimiter) break
      }
    }
    delimiters.length = 0
    return j
  }
  while (i < command.length) {
    const c = command[i]
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end < 0 ? command.length : end
      word = (word ?? '') + command.slice(i + 1, stop)
      i = stop + 1
    } else if (c === '"') {
      let j = i + 1
      let value = ''
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && '"\\$`\n'.includes(command[j + 1] ?? '')) { value += command[j + 1]; j += 2 } else { value += command[j]; j += 1 }
      }
      word = (word ?? '') + value
      i = j + 1
    } else if (c === '\\') {
      if (i + 1 < command.length && command[i + 1] !== '\n') word = (word ?? '') + command[i + 1]
      i += 2
    } else if (c === '#' && word === null) {
      const newline = command.indexOf('\n', i)
      i = newline < 0 ? command.length : newline
    } else if (c === '>' || c === '<' || (c === '&' && command[i + 1] === '>')) {
      if (c === '>' && word !== null && /^\d+$/.test(word)) word = null
      else flush()
      let op = c === '&' ? '&>' : c
      if (command[i + op.length] === op.at(-1)) op += op.at(-1)
      if (op === '<<' && command[i + 2] === '<') op = '<<<'
      if (op === '<<' && command[i + 2] === '-') op = '<<-'
      i += op.length
      if (op.startsWith('>') && command[i] === '&') {
        i += 1
        while (i < command.length && /[\d-]/.test(command[i])) i += 1
        continue
      }
      if (op === '>' && command[i] === '|') { op = '>|'; i += 1 }
      tokens.push({ type: 'redir', value: op })
      if (HEREDOC_REDIRECTS.has(op)) awaitingDelimiter = true
    } else if (c === '\n') {
      flush()
      tokens.push(SEPARATOR)
      i = delimiters.length ? skipBodies() : i + 1
    } else if (';&|()'.includes(c)) {
      flush()
      tokens.push(SEPARATOR)
      i += c === command[i + 1] && (c === '&' || c === '|') ? 2 : 1
    } else if (c === ' ' || c === '\t') {
      flush()
      i += 1
    } else {
      word = (word ?? '') + c
      i += 1
    }
  }
  flush()
  return tokens
}

function segments(tokens) {
  const list = []
  let current = { words: [], redirs: [] }
  let pending = null
  for (const token of tokens) {
    if (token.type === 'op') {
      pending = null
      if (current.words.length || current.redirs.length) list.push(current)
      current = { words: [], redirs: [] }
    } else if (token.type === 'redir') {
      pending = token.value
    } else if (pending) {
      current.redirs.push({ op: pending, target: token.value })
      pending = null
    } else current.words.push(token.value)
  }
  if (current.words.length || current.redirs.length) list.push(current)
  return list
}

// Expand $HOME and $PWD; any other expansion leaves the path unresolvable (null)
function resolvePath(base, raw) {
  const path = raw.replace(HOME_VARIABLE, homedir()).replace(PWD_VARIABLE, base)
  if (UNRESOLVED.test(path)) return null
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? resolve(path) : resolve(base, path)
}

function existingDirectory(path) {
  try { return path !== null && statSync(path).isDirectory() } catch { return false }
}

function shellTargets(command, cwd, observations) {
  const paths = []
  let write = false
  let dir = cwd
  // Returns whether the token qualified, even when it was already collected
  const add = (path, target = false) => {
    if (path === null || path.startsWith(DEVICE_DIR)) return false
    if (!target && !existsSync(path)) return false
    if (paths.length < MAX_SHELL_PATHS && !paths.includes(path)) paths.push(path)
    return true
  }
  const tokens = lex(command)
  if (observations) observations.unresolved = tokens.filter(token => token.type === 'word' && !token.value.startsWith('-') && !ASSIGNMENT.test(token.value) && /[$`*?\[]/.test(token.value.replace(HOME_VARIABLE, homedir()).replace(PWD_VARIABLE, cwd))).length
  for (const segment of segments(tokens)) {
    const words = segment.words.slice()
    while (words.length && (ASSIGNMENT.test(words[0]) || COMMAND_PREFIXES.has(words[0]))) words.shift()
    if (!words.length && !segment.redirs.length) continue
    const name = words.length ? words[0].split('/').at(-1) : ''
    if (SKIPPED_COMMANDS.has(name)) continue
    let segmentDir = dir
    let args = words.slice(1)
    let creates = false
    let segmentWrite = false
    let hits = 0
    if (name === 'cd') {
      const target = args.find(arg => arg !== '--')
      const next = target === undefined ? homedir() : target === '-' ? null : resolvePath(dir, target)
      if (existingDirectory(next)) {
        dir = next
        add(dir)
      }
      continue
    }
    if (name === 'git') {
      let k = 0
      while (k < args.length && args[k].startsWith('-')) {
        if (args[k] === '-C' && k + 1 < args.length) {
          const next = resolvePath(segmentDir, args[k + 1])
          if (existingDirectory(next)) {
            segmentDir = next
            if (add(segmentDir)) hits += 1
          }
          k += 2
        } else k += args[k] === '-c' ? 2 : 1
      }
      const readSubcommands = GIT_READ_SUBCOMMANDS.get(args[k])
      const inspection = readSubcommands?.has(args[k + 1]) ?? false
      segmentWrite = GIT_WRITES.has(args[k]) && !inspection
      args = args.slice(k + 1)
      if (readSubcommands) {
        if (add(segmentDir)) hits += 1
        // A grouped command's subcommand is syntax, not a file operand
        if (args[0] && !args[0].startsWith('-')) args = args.slice(1)
      }
      if (inspection) {
        for (let i = 0; i < args.length && args[i] !== '--'; i += 1) {
          const option = args[i]
          if (option !== GIT_OUTPUT_OPTION && !option.startsWith(`${GIT_OUTPUT_OPTION}=`)) continue
          const value = option === GIT_OUTPUT_OPTION ? args[++i] : option.slice(GIT_OUTPUT_OPTION.length + 1)
          const path = value ? resolvePath(segmentDir, value) : null
          if (path?.startsWith(DEVICE_DIR)) continue
          segmentWrite = true
          if (add(path, true)) hits += 1
        }
      }
    } else if ((name === 'sed' && args.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'))) ||
      (name === 'perl' && args.some(arg => /^-[a-zA-Z]*i/.test(arg)))) {
      segmentWrite = true
    } else if (CREATING_COMMANDS.has(name)) {
      segmentWrite = true
      creates = true
    }
    for (const arg of args) {
      if (arg && !arg.startsWith('-') && add(resolvePath(segmentDir, arg), creates)) hits += 1
    }
    for (const { op, target } of segment.redirs) {
      if (!target || HEREDOC_REDIRECTS.has(op)) continue
      const path = resolvePath(segmentDir, target)
      if (WRITE_REDIRECTS.has(op)) {
        if (path !== null && path.startsWith(DEVICE_DIR)) continue
        segmentWrite = true
        if (add(path, true)) hits += 1
      } else if (op === READ_REDIRECT && add(path)) hits += 1
    }
    // A write with no path token happens in its working directory
    if (segmentWrite && !hits) add(segmentDir)
    write ||= segmentWrite
  }
  if (!paths.length) return write ? { kind: KIND.WRITE, paths } : none()
  return { kind: write ? KIND.WRITE : KIND.READ, paths }
}

function fileTarget(kind, path, cwd) {
  if (typeof path !== 'string' || !path) return none()
  if (isAbsolute(path)) return { kind, paths: [resolve(path)] }
  return cwd ? { kind, paths: [resolve(cwd, path)] } : none()
}

function patchTargets(patch, cwd) {
  const paths = []
  for (const line of patch.split('\n')) {
    const match = PATCH_HEADER.exec(line.trimEnd())
    if (!match) continue
    const raw = match[1].trim()
    const path = isAbsolute(raw) ? resolve(raw) : cwd ? resolve(cwd, raw) : null
    if (path && !paths.includes(path)) paths.push(path)
  }
  return paths.length ? { kind: KIND.WRITE, paths } : none()
}

export function isShellCall(payload) {
  return SHELL_TOOLS.has(String(payload?.tool_name ?? '').split('.').at(-1))
}

export function toolTargets(payload, { observations } = {}) {
  const tool = String(payload?.tool_name ?? '').split('.').at(-1)
  const input = payload?.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}
  const cwd = typeof payload?.cwd === 'string' && isAbsolute(payload.cwd) ? payload.cwd : null
  if (READ_TOOLS.has(tool)) return fileTarget(KIND.READ, input[READ_TOOLS.get(tool)], cwd)
  if (WRITE_TOOLS.has(tool)) return fileTarget(KIND.WRITE, input[WRITE_TOOLS.get(tool)], cwd)
  if (tool === PATCH_TOOL) return patchTargets(String(input.command ?? input.patch ?? ''), cwd)
  if (SHELL_TOOLS.has(tool)) {
    if (observations) observations.unresolved = 0
    const command = input.command ?? input.cmd
    // Codex shell calls may name their directory separately from the session cwd
    const workdir = typeof (input.workdir ?? input.cwd) === 'string' ? input.workdir ?? input.cwd : null
    const base = workdir ? (cwd ? resolve(cwd, workdir) : isAbsolute(workdir) ? workdir : null) : cwd
    if (typeof command !== 'string' || !base) return none()
    return SHELL_PATCH.test(command) ? patchTargets(command, base) : shellTargets(command, base, observations)
  }
  return none()
}

// Character budgets: Claude caps additionalContext at 10,000 characters per field,
// Codex accepted 40 KB in probes, and block reasons reached both models at 40 KB,
// the largest size measured
export const BUDGET = Object.freeze({ claude: 9500, codex: 32000, bounce: 40000 })
const RETRY_LINE = 'The tool call was not run so these instructions could be read first. Re-issue the same call now.'
const NAMED_HEADING = 'Read these files before continuing:'
const PARAGRAPH = '\n\n'
const OUTLINE_HEADING_BYTES = 1536
const OUTLINE_HEADING_LINES = 24

function header(dir, hasFiles) {
  const scope = dir || 'the paths accessed by this tool call'
  return hasFiles
    ? `AGENTS.md instructions that govern ${scope} were not yet in context:`
    : `AGENTS.md files that govern ${scope} repeat instructions already in context:`
}
const coveredNote = entry => `Same content as ${entry.twin}, already in context: ${entry.path} applies under ${dirname(entry.path)}.`
const block = entry => `== ${entry.path} (applies under ${dirname(entry.path)}) ==\n${entry.text.replace(/\n+$/, '')}`
function outline(entry, headingBudget = OUTLINE_HEADING_BYTES) {
  const headings = []
  let bytes = 0
  let omitted = 0
  let fence = null
  for (const line of entry.text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null
      continue
    }
    if (fence || !/^ {0,3}#{1,2}(?:\s|$)/.test(line)) continue
    const size = Buffer.byteLength(line) + 1
    if (headings.length >= OUTLINE_HEADING_LINES || bytes + size > headingBudget) omitted += 1
    else { headings.push(line); bytes += size }
  }
  return [
    `== ${entry.path} (${Buffer.byteLength(entry.text)} bytes; outline) ==`,
    ...headings,
    ...(omitted ? [`(${omitted} more headings omitted)`] : []),
    `The full file applies under ${dirname(entry.path)} and is available to read when its topics are relevant.`,
  ].join('\n')
}
const noteLine = entry => entry.changed
  ? `Not included because of the hook size limit: ${entry.path} (${Buffer.byteLength(entry.text)} bytes) applies under ${dirname(entry.path)} and changed after it was delivered; read it directly to see the current version.`
  : `Not included because of the hook size limit: ${entry.path} (${Buffer.byteLength(entry.text)} bytes) applies under ${dirname(entry.path)}; it will be delivered in full before the first write there.`

function byteParts(text, values) {
  const parts = values.map(({ path, kind, text: value }) => ({ path, kind, bytes: Buffer.byteLength(value) }))
  const wrapperBytes = Buffer.byteLength(text) - parts.reduce((sum, part) => sum + part.bytes, 0)
  if (wrapperBytes < 0) throw new Error('Invalid delivery accounting')
  return [...parts, { path: null, kind: 'wrapper', bytes: wrapperBytes }]
}

const fullPart = entry => ({ path: entry.path, kind: 'full', text: block(entry) })
const coveredPart = entry => ({ path: entry.path, kind: 'covered', text: coveredNote(entry) })

// Include files nearest-first while the rendered text fits, then present them outermost-first
// Covered files repeat content already in context, so they appear only as short notes
function pack(dir, entries, budget, trailer, covered, noteParts) {
  const chosen = new Set()
  const render = () => {
    const blocks = entries.filter((_, i) => chosen.has(i)).map(block)
    const excluded = entries.filter((_, i) => !chosen.has(i))
    const notes = covered.length ? [covered.map(coveredNote).join('\n')] : []
    return [header(dir, blocks.length > 0 || excluded.length > 0), ...blocks, ...notes, ...trailer(excluded)].join(PARAGRAPH)
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    chosen.add(i)
    if (render().length > budget) chosen.delete(i)
  }
  const included = entries.filter((_, i) => chosen.has(i)).map(entry => entry.path)
  const excluded = entries.filter((_, i) => !chosen.has(i)).map(entry => entry.path)
  const text = render()
  const accounting = () => byteParts(text, [
    ...entries.filter((_, i) => chosen.has(i)).map(fullPart),
    ...covered.map(coveredPart),
    ...noteParts(entries.filter((_, i) => !chosen.has(i))),
  ])
  return { text, included, excluded, accounting }
}

// Outline text is exempt, but every full file pays for the final non-outline wrappers
// Keep ordinary packing unchanged when the epoch budget does not constrain it
function packEpoch(dir, entries, budget, trailer, covered, epochBudget, noteParts) {
  const ordinary = pack(dir, entries, budget, trailer, covered, noteParts)
  const allFull = [header(dir, entries.length > 0), ...entries.map(block), ...(covered.length ? [covered.map(coveredNote).join('\n')] : []), ...trailer([])].join(PARAGRAPH)
  const referenced = covered.map(entry => entry.path)
  if (Buffer.byteLength(allFull) <= epochBudget && ordinary.text.length <= budget) return { ...ordinary, capped: [], covered: referenced, deferred: [] }
  const tier = Object.freeze({ FULL: 'full', OUTLINE: 'outline', NOTE: 'note' })
  const kinds = entries.map(() => tier.OUTLINE)
  const outlines = entries.map(entry => outline(entry, 0))
  const deferred = new Set()
  const visibleCovered = covered.slice()
  const render = (includeOutlines = true) => {
    const blocks = entries.flatMap((entry, i) => deferred.has(i) ? [] : kinds[i] === tier.FULL ? [block(entry)] : kinds[i] === tier.OUTLINE && includeOutlines ? [outlines[i]] : [])
    const excluded = entries.filter((_, i) => !deferred.has(i) && kinds[i] === tier.NOTE)
    const pending = deferred.size || visibleCovered.length < covered.length
    return [header(dir, entries.length > 0), ...blocks, ...(visibleCovered.length ? [visibleCovered.map(coveredNote).join('\n')] : []), ...(pending ? ['Additional governing files remain pending because this delivery reached the runtime size limit.'] : []), ...trailer(excluded)].join(PARAGRAPH)
  }
  for (let i = 0; i < entries.length; i += 1) {
    kinds[i] = tier.FULL
    if (Buffer.byteLength(render(false)) > epochBudget) kinds[i] = tier.OUTLINE
    else if (render().length > budget) {
      kinds[i] = tier.NOTE
      if (Buffer.byteLength(render(false)) > epochBudget) kinds[i] = tier.OUTLINE
    }
  }
  // Keep metadata that cannot fit pending rather than claiming it reached the model
  for (;;) {
    const full = entries.flatMap((_, i) => !deferred.has(i) && kinds[i] === tier.FULL ? [i] : [])
    if (full.length && Buffer.byteLength(render(false)) > epochBudget) { kinds[full.at(-1)] = tier.OUTLINE; continue }
    if (render().length <= budget) break
    const remaining = entries.flatMap((_, i) => deferred.has(i) ? [] : [i])
    if (remaining.length) deferred.add(remaining.at(-1))
    else if (visibleCovered.length) visibleCovered.pop()
    else break
  }
  for (let i = 0; i < entries.length; i += 1) {
    if (deferred.has(i) || kinds[i] !== tier.OUTLINE) continue
    const available = Math.max(0, budget - render().length)
    const expanded = outline(entries[i], Math.min(OUTLINE_HEADING_BYTES, available))
    if (expanded.length - outlines[i].length <= available) outlines[i] = expanded
  }
  const text = render()
  const accounting = () => byteParts(text, [
    ...entries.flatMap((entry, i) => deferred.has(i) ? [] : kinds[i] === tier.FULL ? [fullPart(entry)] : kinds[i] === tier.OUTLINE ? [{ path: entry.path, kind: 'outline', text: outlines[i] }] : []),
    ...visibleCovered.map(coveredPart),
    ...noteParts(entries.filter((_, i) => !deferred.has(i) && kinds[i] === tier.NOTE)),
  ])
  return {
    text, accounting,
    included: entries.filter((_, i) => !deferred.has(i) && kinds[i] === tier.FULL).map(entry => entry.path),
    excluded: entries.filter((_, i) => deferred.has(i) || kinds[i] === tier.NOTE).map(entry => entry.path),
    capped: entries.filter((_, i) => !deferred.has(i) && kinds[i] === tier.OUTLINE).map(entry => entry.path),
    deferred: entries.filter((_, i) => deferred.has(i)).map(entry => entry.path),
    covered: visibleCovered.map(entry => entry.path),
  }
}

export function packContext(dir, entries, budget, covered = [], options = {}) {
  if (!entries.length && !covered.length) return { text: '', sent: [], noted: [] }
  const trailer = excluded => excluded.map(noteLine)
  const noteParts = excluded => excluded.map(entry => ({ path: entry.path, kind: 'note', text: noteLine(entry) }))
  const { text, included, excluded, capped, deferred, accounting, covered: referenced } = options.epochBudget === undefined
    ? pack(dir, entries, budget, trailer, covered, noteParts)
    : packEpoch(dir, entries, budget, trailer, covered, options.epochBudget, noteParts)
  return { text, accounting, sent: included, noted: excluded, ...(capped ? { capped, deferred, covered: referenced } : {}) }
}

export function bounceReason(dir, entries, budget, covered = [], options = {}) {
  const trailer = excluded => [
    ...(excluded.length ? [`${NAMED_HEADING}\n${excluded.map(entry => `- ${entry.path}`).join('\n')}`] : []),
    RETRY_LINE,
  ]
  const noteParts = excluded => excluded.map(entry => ({ path: entry.path, kind: 'note', text: `- ${entry.path}` }))
  const { text, included, excluded, capped, deferred, accounting, covered: referenced } = options.epochBudget === undefined
    ? pack(dir, entries, budget, trailer, covered, noteParts)
    : packEpoch(dir, entries, budget, trailer, covered, options.epochBudget, noteParts)
  return { text, accounting, sent: included, named: excluded, ...(capped ? { capped, deferred, covered: referenced } : {}) }
}
