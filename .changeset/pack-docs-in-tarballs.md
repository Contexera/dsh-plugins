---
'@contexera/dsh-channel-gateway': patch
'@contexera/dsh-context-continuity': patch
'@contexera/dsh-jev': patch
---

Ship each package's architecture documents in its npm tarball.

Every README links the package's own `docs/` pages, but `files` did not list
`docs/`, so a reader who installed the package followed a link to a path that
did not exist. All three manifests now include `docs/**/*.md`.

The new `pnpm check:pack` gate packs each package the way `npm publish` would
and fails when a README or a document links a path the tarball does not carry,
so this cannot regress silently. CI runs it after `pnpm -r build`, and
`pnpm release` runs it before `changeset publish`.
