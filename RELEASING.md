# Releasing

Each package publishes to npm on its own cadence. [README.md](README.md#releasing)
lists the three commands; this file is the operator's runbook — what a release
consists of, in what order it happens, and what has to be verified before it is
public.

## What a release consists of

| Face | Rule |
| --- | --- |
| Tag | `@wowyuarm/dsh-<name>@X.Y.Z` — the shape changesets gives a non-root package. A bare `vX.Y.Z` cannot name one of two packages. |
| Tag target | The release commit: the one whose `package.json` carries that version and whose `CHANGELOG.md` holds that section. |
| GitHub Release | Title = the tag, body = that version's `CHANGELOG.md` section verbatim, `--latest=false`. |
| npm | The tarball `changeset publish` uploads. |
| `CHANGELOG.md` | Written by `changeset version`. It is the only place release notes are written. |

Two rules are not negotiable:

- **A published `name@version` is burned.** Fix a bad release with a new patch —
  never by republishing, retagging, or rewriting tagged history. `npm deprecate`
  is the only sanctioned cleanup.
- **A prerelease gets no GitHub Release**, and stays off the `latest` dist-tag.

## Steps

1. **Land a changeset with the change** (`pnpm changeset`): patch, minor, or major.

2. **On the go signal, version and verify:**

   ```sh
   pnpm install --frozen-lockfile
   pnpm check:peers
   pnpm -r typecheck && pnpm -r test && pnpm -r build
   pnpm version-packages          # applies bumps, writes each CHANGELOG.md
   ```

   Read the version diff and the new changelog sections, then commit them.

3. **Push the release commit behind a fence.** Both CI lanes must pass before
   anything is tagged:

   ```sh
   git push --dry-run origin refs/heads/master:refs/heads/master   # fence: exactly one ref, fast-forward
   git push origin refs/heads/master:refs/heads/master
   ```

   Treat a pushed release commit as final: the tag and the published version
   will point at it, so it is not rewritten afterwards.

4. **Publish, then push the tag it created** — tag by tag, never `--tags` or
   `--all`, so local scratch refs cannot leave the machine:

   ```sh
   pnpm release                        # build, then changeset publish
   git tag -l '@wowyuarm/*'            # the tags publish just created
   git push --dry-run origin 'refs/tags/<tag>:refs/tags/<tag>'
   git push origin 'refs/tags/<tag>:refs/tags/<tag>'
   ```

   Push the tag *before* creating the Release: `gh release create` on a tag that
   does not exist yet creates it at the branch head, which is not the release
   commit. `--verify-tag` below turns that order into a hard failure instead of
   a rule to remember.

5. **Verify the published artifact, not the source tree.** Read the version back
   from the registry rather than from `latest`, which can still serve the
   previous version seconds after a publish:

   ```sh
   curl -sf "https://registry.npmjs.org/@wowyuarm%2Fdsh-<name>/<version>" >/dev/null && echo ok
   npm pack "@wowyuarm/dsh-<name>@<version>"        # compare its package.json with the workspace one
   dsh plugin --profile <temp-profile> add "@wowyuarm/dsh-<name>@<version>"
   ```

   Install the **exact version**: a version younger than the resolver's
   `minimumReleaseAge` window otherwise resolves to the previous release and
   silently verifies the wrong build. The last command is the one that proves
   `files`, `exports`, and `dsh.bundle.patch` survive packing — unit tests
   against the source tree cannot.

6. **Create the Release**, then leave the published version alone:

   ```sh
   gh release create '<tag>' --title '<tag>' --latest=false --verify-tag --notes-file <section.md>
   ```

## Moving a package's DSH line

A package's `@deepseek-ai/dsh-*` peers declare exactly one line,
`>=<baseline> <next>`, pinned in `devDependencies` to the version the tests run
against. `pnpm check:peers` keeps the two in step, offline; adding `--upstream`
prints the published dist-tags next to the declared ranges when the line is up
for a decision. Moving a line is an ordinary change with a changeset, not a
release step.

## What a package declares as peers

Declare the narrowest surface that is true, in two classes:

- **`@deepseek-ai/dsh-*` (the harness line).** Only the modules the package's
  `src/` actually imports, each written `>=<baseline> <next line>`, where the
  baseline is the oldest version verified — a prerelease counts. Never a caret
  and never an exact pin: `>=0.2.0-rc.1 <0.2.1` admits every prerelease of the
  line and the final `0.2.0`, and stops at `0.2.1`; `^0.2.0-rc.1` would admit
  `0.2.1`, while `>=0.2.0 <0.2.1` would exclude every host still on a
  prerelease. `pnpm check:peers` enforces the form, the single baseline and the
  matching exact `devDependencies` pin on both CI lanes.
- **`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, and other
  independently-versioned packages.** A caret on the major (`^4.0.1`): their
  compatibility unit is the major, not the harness line, so `check:peers`
  deliberately does not police this class. A major bump is a re-certification
  event like a line move — move it deliberately, never widen it to make an
  install pass.

A package that imports no `@deepseek-ai/dsh-*` module has no DSH line at all and
is installable on every harness line: that is the default, not a gap. Never
declare the umbrella `@deepseek-ai/dsh` as a peer — plugins import sub-packages,
and the line is already stated exactly by the class above.

Narrow means one line, not one version. Every line move is a downstream install
boundary and costs a release of its own; a package that must work across lines
needs runtime probing, not a wider range.
