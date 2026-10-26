import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const skipped = new Set(['.git', 'node_modules', '.superpowers', 'coverage'])
const machinePath = /(?:^|[\s"'=(])\/(?:Users\/[^/\s]+|home\/[^/\s]+|[xwcz]\/)/m
async function inspect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skipped.has(entry.name) || entry.name.endsWith('.tgz')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await inspect(path)
    else if (entry.isFile()) {
      const text = await readFile(path, 'utf8')
      if (machinePath.test(text)) throw new Error(`Machine-specific path in ${relative(root, path)}`)
      if (path.endsWith('.mjs') || entry.name === 'agents-chain-report') execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })
    }
  }
}
await inspect(root)
console.log('Syntax and portable-path checks passed')
