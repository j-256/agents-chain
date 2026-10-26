// Owner-only storage primitives used by the hook, independent of other tooling
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink, lstat, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const failure = code => Object.assign(new Error(code), { code })

export function stateRoot(env = process.env) {
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  if (!isAbsolute(base)) throw failure('STATE_PATH_INVALID')
  return join(base, 'agents-chain')
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

export async function secureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw failure('STATE_DIRECTORY_UNSAFE')
  await chmod(path, 0o700)
}

export async function readPrivateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw failure('STATE_FILE_UNSAFE')
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}

export async function atomicJson(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(data, null, 2)}\n`); await file.sync() }
    finally { await file.close() }
    await rename(temp, path)
  } finally { await unlink(temp).catch(() => {}) }
}

export class Store {
  constructor(identity, root = stateRoot()) {
    this.id = createHash('sha256').update(identity).digest('hex')
    this.root = root
    this.dir = join(root, this.id)
  }

  async prepare() {
    await secureDirectory(this.root)
    await secureDirectory(this.dir)
  }
}
