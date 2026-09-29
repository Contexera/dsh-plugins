#!/usr/bin/env node
/**
 * The package boundary guard.
 *
 * This package is a provider any DeepSeek Harness host can mount, and it
 * declares exactly two peers: `@deepseek-ai/cordis` for the service and the
 * context augmentation, `@deepseek-ai/schemastery` for configuration
 * validation. `src/` may therefore import only its own relative modules, Node
 * builtins, and those two — no `@deepseek-ai/dsh-*` package, and no host
 * package. That constraint is what keeps the package installable on every DSH
 * line at once: a `dsh-*` import would tie it to one line and force the kind of
 * adapter churn the two-peer shape avoids.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

/** Peers the source may name, by package base name. */
const ALLOWED_PACKAGES = new Set(['@deepseek-ai/cordis', '@deepseek-ai/schemastery'])

/** `relative()` speaks the host separator; this guard speaks POSIX. */
const posix = (path) => path.split(sep).join('/')

/** `... from '<spec>'` — named, default, and `import type` statements alike. */
const FROM_RE = /\bfrom\s+'([^']+)'/g
/** A side-effect import: `import '<spec>'`. */
const BARE_RE = /^\s*import\s+'([^']+)'/gm
/** A dynamic import: `import('<spec>')`. */
const DYNAMIC_RE = /\bimport\(\s*'([^']+)'\s*\)/g

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
const files = sourceFiles(SRC)
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const specifiers = []
  for (const match of source.matchAll(FROM_RE)) specifiers.push(match[1])
  for (const match of source.matchAll(BARE_RE)) specifiers.push(match[1])
  for (const match of source.matchAll(DYNAMIC_RE)) specifiers.push(match[1])
  for (const specifier of specifiers) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) continue
    if (specifier.startsWith('node:')) continue
    const name = packageOf(specifier)
    if (name !== undefined && ALLOWED_PACKAGES.has(name)) continue
    violations.push(`${posix(relative(ROOT, file))} imports '${specifier}'`)
  }
}

if (violations.length > 0) {
  console.error('Boundary violations — src/ may import only relative modules, node: builtins, and the declared peers:')
  for (const violation of violations) console.error(`  - ${violation}`)
  process.exit(1)
}
console.log(`boundaries: ${files.length} file(s) within the declared peers`)
