#!/usr/bin/env node
/**
 * Comment hygiene: a per-scope budget, and references that cannot resolve.
 *
 * WHY A BUDGET. `AGENTS.md` states the policy — comments state non-obvious
 * constraints and reasons, never restate the code — but nothing measured it, so
 * it drifted: a full audit on 2026-10-17 found 3201 comment lines over 9566 lines
 * of `src/`, with single files at 44% (pressure.ts, 307/703). A budget makes the
 * next drift visible: a scope that exceeds its recorded number fails, and
 * someone has to decide. It is the same mechanism `dsh-agent-team` uses.
 *
 * The budget is a ceiling recorded when it was reviewed. It ratchets down as
 * comments are condensed and rises only deliberately, in a commit that says why.
 * It is a proxy, not a proof: it cannot tell a comment that earns its place from
 * one that restates the line below it.
 *
 * WHY BANNED REFERENCES. A comment may cite a maintained document or a real
 * GitHub issue. It may not cite an unreleased work-item number or an acceptance
 * criterion: neither resolves for a reader of the published package, and neither
 * is an authority for behavior.
 *
 * SCOPE LIMITS. Tests are excluded: a test's comment often records the
 * regression it pins, a kind this budget must not squeeze. Only whole comment
 * lines count, so formatting a trailing comment cannot move the number.
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Reviewed 2026-10-17, after the comment audit. Raise one only in a commit that
// says why; lower it when a scope is condensed.
//
// Each budget is the audited count plus slack (roughly 2%, floored at 10) that
// absorbs one ordinary change. A commit that adds comments adds on the order of
// a few dozen lines here, so slack clears any normal change and needs sustained
// drift to trip.
const COMMENT_BUDGETS = {
  'packages/channel-gateway/src': 500,
  'packages/context-continuity/src': 1080,
  'packages/jev/src': 230,
  'scripts': 130,
}

const EXCLUDED_DIRECTORY = 'vendor'

const BANNED_REFERENCES = [
  [/\.scratch\/[A-Za-z0-9]/, 'work history is not an authority and is not published'],
  [/\btask #[0-9]/, 'work-item numbers live only in unreleased work history'],
  [/\bissue [0-9]+ criterion/i, 'acceptance criteria live only in unreleased work history'],
]

const SOURCE_PATTERN = /\.(?:ts|tsx|mjs)$/
const IGNORED_DIRECTORY = new Set(['node_modules', 'lib', 'dist'])
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/
const COMMENT_BODY = /^\s*(?:\/\/|\/\*|\*)\s?(.*)$/

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORY.has(entry.name)) found.push(...await sourceFiles(path))
      continue
    }
    if (entry.isFile() && SOURCE_PATTERN.test(entry.name)) found.push(path)
  }
  return found
}

const scopes = [
  ...(await readdir(join(root, 'packages'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !IGNORED_DIRECTORY.has(entry.name))
    .map(entry => `packages/${entry.name}/src`),
  'scripts',
]

const violations = []
const rows = []

for (const scope of scopes) {
  const budget = COMMENT_BUDGETS[scope]
  if (budget === undefined) {
    violations.push(`${scope} has no comment budget — add a row to COMMENT_BUDGETS in scripts/check-comments.mjs`)
    continue
  }
  let lines = 0
  for (const file of await sourceFiles(join(root, scope))) {
    if (relative(root, file).split('/').includes(EXCLUDED_DIRECTORY)) continue
    const text = await readFile(file, 'utf8')
    for (const [index, line] of text.split('\n').entries()) {
      if (!COMMENT_LINE.test(line)) continue
      lines += 1
      const body = COMMENT_BODY.exec(line)?.[1] ?? ''
      for (const [pattern, why] of BANNED_REFERENCES) {
        if (pattern.test(body)) {
          violations.push(`${relative(root, file)}:${index + 1} cites a reference that cannot resolve — ${why}`)
        }
      }
    }
  }
  rows.push(`${scope} ${lines}/${budget}`)
  if (lines > budget) {
    violations.push(`${scope} holds ${lines} comment line(s), over its recorded budget of ${budget}`)
  }
}

if (violations.length > 0) {
  console.error('Comment check FAILED:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error('\nA scope over budget: condense the comments there, or raise its row in')
  console.error('COMMENT_BUDGETS in scripts/check-comments.mjs deliberately, in a commit that says why.')
  console.error('A citation that cannot resolve: point at a maintained document instead.')
  process.exit(1)
}

console.log(`Comment check OK: ${rows.join(', ')} (comment lines / reviewed budget).`)
