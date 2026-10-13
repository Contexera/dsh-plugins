// Every document a package README points at must actually ship in its tarball.
//
// A package's README is the npm landing page, and these READMEs link their own
// architecture documents — but `files` in package.json decides what the tarball
// carries, and a directory that is not listed is simply absent. A reader of the
// published package then follows a link to a path that does not exist, and
// nothing in the build, the type checker or the unit tests notices, because the
// file is present in the repository the whole time.
//
// This gate packs each package the way `npm publish` would (`--dry-run`, so
// nothing is written and no registry is contacted) and asserts two things:
//
//   (a) every package ships at least one `docs/**/*.md`, so a package cannot
//       quietly drop its documentation from the published artifact;
//   (b) every relative Markdown link from the README and from the docs
//       themselves resolves to a file that the same tarball contains — the
//       mechanical form of "no documented path is missing from the tarball".
//
// Both are read from the pack output rather than from the working tree, so the
// check tracks `files` and `.npmignore` instead of restating them.
//
// The packer is `npm pack` — the command `npm publish` is built on, so the gate
// reads the file list the registry would actually receive. It is not a read-only
// probe: `npm pack` runs a `prepack` script when the manifest declares one, and
// channel-gateway and jev both use `prepack` to build, so packing either of them
// re-derives its `lib/`. Run it after `pnpm -r build`, as CI does — a package
// without `prepack` (context-continuity) ships whatever `lib/` that build left,
// and would otherwise pack no `lib/` at all.
//
// `--root <dir>` runs the same checks against another tree (fixtures).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argvValue = flag => {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}
const root = argvValue('--root') === undefined ? repositoryRoot : resolve(argvValue('--root'))

const failures = []
const rows = []

/** The workspace's package directories, from the same source the other gates read. */
function packageDirs() {
  const source = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const lines = source.split('\n')
  const start = lines.findIndex(line => /^packages:\s*$/u.test(line))
  if (start === -1) {
    failures.push('pnpm-workspace.yaml: no packages: block')
    return []
  }
  const dirs = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break
    const match = /^\s+-\s+(\S+)\s*$/u.exec(line)
    if (match === null || !match[1].endsWith('/*')) continue
    const base = match[1].slice(0, -2)
    for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = `${base}/${entry.name}`
      if (existsSync(join(root, dir, 'package.json'))) dirs.push(dir)
    }
  }
  return dirs.sort()
}

/**
 * The pack command to run, as one `file` plus `args`.
 *
 * On Windows the npm entry point is `npm.cmd`, and a `.cmd` file cannot be
 * started by `execFile`: libuv's PATH search appends only `.com`/`.exe` rather
 * than reading `PATHEXT`, and Node refuses to launch a `.cmd`/`.bat` without a
 * shell. The command therefore goes through the interpreter named by
 * `ComSpec`, which is what a terminal would do. Passing the whole command as one
 * `/c` argument keeps `shell: true` out of it — that option is deprecated in
 * combination with an argument list (DEP0190), since the arguments would be
 * concatenated rather than escaped.
 */
function packCommand() {
  const args = ['pack', '--dry-run', '--json']
  if (process.platform !== 'win32') return { file: 'npm', args }
  const interpreter = process.env.ComSpec ?? 'cmd.exe'
  return { file: interpreter, args: ['/d', '/s', '/c', `npm ${args.join(' ')}`] }
}

/**
 * The paths `npm publish` would put in the tarball for one package. A pack
 * failure is reported, never thrown, so one broken manifest does not hide the
 * others' results.
 */
function packedPaths(dir) {
  let stdout
  const command = packCommand()
  try {
    stdout = execFileSync(command.file, command.args, {
      cwd: join(root, dir),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    failures.push(`${dir}: npm pack --dry-run failed — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    return []
  }
  const parsed = JSON.parse(stdout)
  const paths = (Array.isArray(parsed) ? parsed[0] : parsed).files.map(entry => entry.path)
  return paths
}

/** Markdown links between files in the same tarball: images, docs, LICENSE. */
function relativeLinks(markdown) {
  const links = []
  // Inline links and images: `[text](target)` / `![alt](target)`. A title
  // (`"..."`) and a wrapped `<...>` destination are both allowed by Markdown.
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/gu)) links.push(match[1])
  for (const match of markdown.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?\s*$/gmu)) links.push(match[1])
  return links.filter(link => !/^[a-z][a-z0-9+.-]*:/iu.test(link) && !link.startsWith('#') && !link.startsWith('/'))
}

for (const dir of packageDirs()) {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
  const paths = packedPaths(dir)
  const shipped = new Set(paths)
  const docs = paths.filter(path => path.startsWith('docs/') && path.endsWith('.md'))

  if (docs.length === 0) {
    failures.push(`${manifest.name}: its tarball ships no docs/*.md — a README that links its own architecture documents must carry them`)
  }

  // Every Markdown file in the tarball is a link source; a link that leaves the
  // tarball as a relative path is a broken link for whoever installed it.
  let checked = 0
  for (const path of paths.filter(candidate => candidate.endsWith('.md'))) {
    for (const raw of relativeLinks(readFileSync(join(root, dir, path), 'utf8'))) {
      // A fragment addresses a heading inside the target, not a different file,
      // and a query is meaningless for a path on disk; only the path part is
      // something the tarball has to contain.
      const link = raw.split('#')[0].split('?')[0]
      if (link === '') continue
      const target = posix.normalize(posix.join(posix.dirname(path), decodeURIComponent(link)))
      checked += 1
      if (shipped.has(target)) continue
      failures.push(`${manifest.name}: ${path} links "${raw}", whose target the tarball does not contain (looked for ${target})`)
    }
  }
  rows.push([manifest.name, String(paths.length), String(docs.length), String(checked)])
}

const columns = ['package', 'tarball files', 'docs/*.md', 'links checked']
const widths = columns.map((header, column) => Math.max(header.length, ...rows.map(row => row[column].length)))
const line = row => `  ${row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  ')}`
console.log(`\nPack contents (${root}):`)
console.log(line(columns))
console.log(line(widths.map(width => '─'.repeat(width))))
for (const row of rows) console.log(line(row))

if (failures.length > 0) {
  console.error(`\nTarball documentation gaps (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('\nAdd the missing path to that package\'s package.json "files" list.')
  process.exit(1)
}
console.log(`\nEvery package ships its documentation (${rows.length} package(s)).`)
