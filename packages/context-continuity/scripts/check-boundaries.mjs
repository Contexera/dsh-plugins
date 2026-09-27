#!/usr/bin/env node
/**
 * The package boundary guard.
 *
 * This package exists to be reused by hosts that share nothing but DeepSeek
 * Harness: the Agent Team today, Loom or a single-subject harness later. The
 * engine may therefore import only its own relative modules, Node builtins, and
 * the declared `@deepseek-ai/dsh-*` peers. A host package, a sibling harness
 * source path, or any undeclared dependency leaking into `src/` would quietly
 * make the engine host-specific again — the one thing the extraction prevents.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

/** Import specifiers the engine may name, by package base name. */
const ALLOWED_PACKAGES = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-tools',
  'zod',
])

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

/** The package base name of one bare specifier: `@scope/name/sub` -> `@scope/name`. */
function basePackageOf(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

const violations = []
for (const file of sourceFiles(SRC)) {
  const text = readFileSync(file, 'utf8')
  const specifiers = [...text.matchAll(FROM_RE), ...text.matchAll(BARE_RE)]
    .map(match => match[1])
  for (const specifier of specifiers) {
    const where = `${file.slice(ROOT.length)}: ${specifier}`
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue
    if (specifier.startsWith('node:')) continue
    if (ALLOWED_PACKAGES.has(basePackageOf(specifier))) continue
    violations.push(where)
  }
}

if (violations.length > 0) {
  console.error('package boundary violated — src/ may import only relative modules, node: builtins, and the declared dsh peers:')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log('package boundary OK')
