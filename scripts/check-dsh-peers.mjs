// The DSH version contract of every workspace package, read back mechanically.
//
// A published plugin states two facts about the host line it runs on: the peer
// range it admits, and the exact version its own test tree compiles and runs
// against. This gate reads both back and refuses to let them drift:
//
//   (a) every `@deepseek-ai/dsh-*` peer is written in the exact
//       `>=<baseline> <next line>` form, and one package's peers all share that
//       baseline and that upper bound — a caret or a narrower range hides which
//       line was actually verified;
//   (b) every such peer is present in `devDependencies` as an exact pin equal
//       to the baseline: the line we test is the line we promise from, so
//       "we admit from rc.1" cannot survive a test tree pinned to rc.2;
//   (c) a package with no `@deepseek-ai/dsh-*` peer is reported as not
//       applicable instead of failed — channel-gateway's host contract is
//       `cordis` + `schemastery`, and it has no DSH line to certify.
//
// Offline and deterministic on purpose: the baseline is a pinned exact version,
// never "whatever npm published today", so an upstream prerelease cannot red a
// gate that should only move when a human decides to move it. `--upstream`
// prints what npm currently offers next to those ranges, for that decision, and
// never changes the exit code.
//
// `--root <dir>` runs the same checks against another tree (fixtures).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_PACKAGE_PREFIX = '@deepseek-ai/dsh-'
const RANGE = /^>=(\S+) <(\S+)$/u
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argvValue = flag => {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}
const root = argvValue('--root') === undefined ? repositoryRoot : resolve(argvValue('--root'))
const reportUpstream = process.argv.includes('--upstream')

const failures = []
const rows = []
const certified = []

const read = path => readFileSync(join(root, path), 'utf8')
const parseVersion = version => {
  const match = VERSION.exec(version)
  return match === null
    ? undefined
    : { tuple: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] }
}
const compareTuples = (left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]

// pnpm-workspace.yaml is the single source of the package list. Only the
// `dir/*` glob shape is expanded, so a new pattern fails loudly here instead of
// silently dropping packages out of the contract.
//
// Read only the `packages:` block. The rest of this file is pnpm's own
// configuration and it also carries list entries — `minimumReleaseAgeExclude`
// rows are package specs, not workspace patterns — so a whole-file scrape would
// feed them to the pattern check and red the gate for a reason that has nothing
// to do with the DSH contract.
const readWorkspacePatterns = source => {
  const lines = source.split('\n')
  const start = lines.findIndex(line => /^packages:\s*$/u.test(line))
  if (start === -1) return { patterns: [], unreadable: [] }
  const patterns = []
  const unreadable = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break // the next top-level key ends the block
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^\s+-\s+(\S+)\s*$/u.exec(line)
    if (match === null) unreadable.push(line.trim())
    else patterns.push(match[1])
  }
  return { patterns, unreadable }
}
const workspace = readWorkspacePatterns(read('pnpm-workspace.yaml'))
const patterns = workspace.patterns
for (const line of workspace.unreadable) {
  failures.push(`pnpm-workspace.yaml: "${line}" in the packages: block is not a "- <pattern>" entry, so the package list stops being readable`)
}
if (patterns.length === 0) failures.push('pnpm-workspace.yaml: no package pattern found')
const packageDirs = []
for (const pattern of patterns) {
  if (!pattern.endsWith('/*')) {
    failures.push(`pnpm-workspace.yaml: this script expands only "dir/*" patterns, not "${pattern}"`)
    continue
  }
  const base = pattern.slice(0, -2)
  for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = `${base}/${entry.name}`
    if (existsSync(join(root, dir, 'package.json'))) packageDirs.push(dir)
    else failures.push(`${dir}: matched by the workspace pattern but has no package.json`)
  }
}
packageDirs.sort()

for (const dir of packageDirs) {
  const manifest = JSON.parse(read(`${dir}/package.json`))
  const peers = Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => name.startsWith(DSH_PACKAGE_PREFIX)).sort(([left], [right]) => left.localeCompare(right))
  const pins = new Map(Object.entries(manifest.devDependencies ?? {})
    .filter(([name]) => name.startsWith(DSH_PACKAGE_PREFIX)))

  if (peers.length === 0) {
    rows.push([manifest.name, '—', '—', 'no DSH peers — not applicable'])
    if (pins.size > 0) {
      failures.push(`${dir}: pins ${pins.size} @deepseek-ai/dsh-* devDependencies but declares no DSH peer range`)
    }
    continue
  }

  const baselines = new Set()
  const upperBounds = new Set()
  for (const [name, range] of peers) {
    const match = RANGE.exec(range)
    if (match === null) {
      failures.push(`${dir}: peer ${name} is "${range}" — expected the exact form ">=<baseline> <next line>", so the verified line stays readable`)
      continue
    }
    baselines.add(match[1])
    upperBounds.add(match[2])
  }
  const baseline = [...baselines][0]
  const upperBound = [...upperBounds][0]
  if (baselines.size > 1) failures.push(`${dir}: DSH peers disagree on the baseline (${[...baselines].join(', ')}) — one package certifies one line`)
  if (upperBounds.size > 1) failures.push(`${dir}: DSH peers disagree on the upper bound (${[...upperBounds].join(', ')})`)
  if (baseline !== undefined && parseVersion(baseline) === undefined) failures.push(`${dir}: baseline "${baseline}" is not an exact version`)
  if (upperBound !== undefined && parseVersion(upperBound) === undefined) failures.push(`${dir}: upper bound "${upperBound}" is not an exact version`)
  if (baseline !== undefined && baseline === upperBound) failures.push(`${dir}: range ">=${baseline} <${upperBound}" admits nothing`)

  for (const [name] of peers) {
    if (!pins.has(name)) {
      failures.push(`${dir}: peer ${name} has no exact devDependency pin — nothing would verify that line`)
      continue
    }
    const pinned = pins.get(name)
    if (parseVersion(pinned) === undefined) failures.push(`${dir}: devDependency ${name} is "${pinned}" — expected an exact pin, so the verified line stays readable`)
    else if (baseline !== undefined && pinned !== baseline) failures.push(`${dir}: devDependency ${name} pins ${pinned} but the peers certify from ${baseline} — the line we test must be the line we promise from`)
  }

  const peerNames = new Set(peers.map(([name]) => name))
  const extraPins = [...pins].filter(([name]) => !peerNames.has(name))
  const testTree = [...new Set(peers.filter(([name]) => pins.has(name)).map(([name]) => pins.get(name)))]
  rows.push([
    manifest.name,
    String(peers.length),
    baseline === undefined ? '—' : `>=${baseline} <${upperBound}`,
    `${testTree.join(', ') || '—'}${extraPins.length === 0 ? '' : ` (+${extraPins.length} dev-only)`}`,
  ])
  if (baseline !== undefined) {
    certified.push({ name: manifest.name, baseline, upperBound, sample: peers[0][0] })
  }
}

const columns = ['package', 'peers', 'declared line', 'test tree']
const widths = columns.map((header, column) => Math.max(...rows.map(row => row[column].length), header.length))
const line = row => `  ${row.map((cell, column) => (column === 1 ? cell.padStart(widths[column]) : cell.padEnd(widths[column]))).join('  ')}`
console.log(`\nDSH peer contract (${root}):`)
console.log(line(columns))
console.log(line(widths.map(width => '─'.repeat(width))))
for (const row of rows) console.log(line(row))

if (reportUpstream) {
  console.log('\nnpm dist-tags of the certified line, next to every declared range (information only — never a failure):')
  if (certified.length === 0) console.log('  no package declares a DSH line, nothing to compare')
  for (const sample of [...new Set(certified.map(entry => entry.sample))]) {
    const tags = await npmDistTags(sample)
    if (tags === undefined) {
      console.log(`  ${sample}: npm lookup failed — skipped`)
      continue
    }
    for (const [tag, version] of Object.entries(tags)) {
      for (const entry of certified.filter(candidate => candidate.sample === sample)) {
        console.log(`  ${tag} ${version} → ${entry.name}: ${verdict(version, entry)}`)
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`\nDSH peer contract violations (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('\nFix the manifest(s) above; `--upstream` shows what npm currently offers next to these ranges.')
  process.exit(1)
}
console.log(`\nDSH peer contract holds (${certified.length} package(s) certified, ${rows.length - certified.length} without a DSH line).`)

/** Abbreviated registry metadata: dist-tags only, and a missing/failed lookup is not a failure. */
async function npmDistTags(name) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!response.ok) return undefined
    return (await response.json())['dist-tags']
  } catch {
    return undefined
  }
}

/**
 * A stable release is judged exactly: inside the declared window or not. A
 * prerelease is judged by its version tuple only — a new prerelease is a
 * decision to make, not an alarm, and full semver range semantics (which would
 * exclude `0.1.8-rc.1` from `<0.1.8`) are deliberately not reimplemented here.
 * Below the baseline and beyond the upper bound are reported separately: only
 * the latter means the declared range has to move.
 */
function verdict(version, { baseline, upperBound }) {
  const candidate = parseVersion(version)
  const lower = parseVersion(baseline)
  const upper = parseVersion(upperBound)
  if (candidate === undefined || lower === undefined || upper === undefined) return 'unreadable version — judge by hand'
  const below = compareTuples(candidate.tuple, lower.tuple) < 0
  const beyond = compareTuples(candidate.tuple, upper.tuple) >= 0
  if (candidate.prerelease !== undefined) {
    if (below) return `older than the certified baseline ${baseline} (prerelease — not the line to decide about)`
    return beyond
      ? 'beyond the upper bound (prerelease — the range must move before that line ships)'
      : 'same line as the certified range (prerelease — a decision, not an alarm)'
  }
  if (below) return `older than the certified baseline ${baseline} — outside the range we admit, widen it only on purpose`
  return beyond
    ? 'OUTSIDE the declared range — the contract must move before that line ships'
    : 'inside the declared range'
}
