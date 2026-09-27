#!/usr/bin/env node
/**
 * The package boundary guard.
 *
 * This package exists to be reused by any host that runs DeepSeek Harness, so
 * `src/` may import only its own relative modules, Node builtins, and the peers
 * it declares. A host package, a sibling harness source path, or an undeclared
 * dependency leaking into the core would tie the neutral seam to one consumer —
 * the one thing this package exists to avoid. Adapters may additionally use the
 * HTTP client they need, and nothing else.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

/** `relative()` speaks the host separator; this guard speaks POSIX. */
const posix = (path) => path.split(sep).join('/')

/** Peers the core may name, by package base name. */
const CORE_PACKAGES = new Set(['@deepseek-ai/cordis', '@deepseek-ai/schemastery'])
/** What an adapter may name on top of the core set. */
const ADAPTER_PACKAGES = new Set(['undici'])

/** `... from '<spec>'` — named, default, and `import type` statements alike. */
const FROM_RE = /\bfrom\s+'([^']+)'/g
/** A side-effect import: `import '<spec>'`. */
const BARE_RE = /^\s*import\s+'([^']+)'/gm

function sourceFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

/** The package base name of an import specifier, e.g. `@scope/name`. */
function packageOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const violations = []
for (const file of sourceFiles(SRC)) {
  const source = readFileSync(file, 'utf8')
  const isAdapter = posix(relative(SRC, file)).startsWith('adapters/')
  const allowed = isAdapter ? new Set([...CORE_PACKAGES, ...ADAPTER_PACKAGES]) : CORE_PACKAGES
  const specifiers = []
  for (const match of source.matchAll(FROM_RE)) specifiers.push(match[1])
  for (const match of source.matchAll(BARE_RE)) specifiers.push(match[1])
  for (const specifier of specifiers) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) continue
    if (specifier.startsWith('node:')) continue
    const name = packageOf(specifier)
    if (name !== undefined && allowed.has(name)) continue
    violations.push(`${posix(relative(ROOT, file))} imports '${specifier}'`)
  }
}

if (violations.length > 0) {
  console.error('Boundary violations:')
  for (const violation of violations) console.error(`  - ${violation}`)
  process.exit(1)
}
console.log(`boundaries: ${sourceFiles(SRC).length} file(s) within the declared peers`)
