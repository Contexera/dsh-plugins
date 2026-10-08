# dsh-plugins

Monorepo for the published [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugins under the `@wowyuarm` scope. Each package is published to npm
independently; the repo only unifies tooling, dependency management, and release.

## Packages

| Package | npm |
| --- | --- |
| [`packages/channel-gateway`](packages/channel-gateway) | [`@contexera/dsh-channel-gateway`](https://www.npmjs.com/package/@contexera/dsh-channel-gateway) |
| [`packages/context-continuity`](packages/context-continuity) | [`@contexera/dsh-context-continuity`](https://www.npmjs.com/package/@contexera/dsh-context-continuity) |
| [`packages/jev`](packages/jev) | [`@contexera/dsh-jev`](https://www.npmjs.com/package/@contexera/dsh-jev) |

## Development

```bash
pnpm install
pnpm -r typecheck   # strict TypeScript, no emit
pnpm -r test        # package boundary check + unit tests
pnpm -r build       # emit each package's lib/
```

Run a single package with a filter, e.g. `pnpm --filter @contexera/dsh-context-continuity test`.

## Releasing

Each package is versioned and released on its own cadence through
[changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset           # record intended version bumps
pnpm version-packages    # apply bumps + changelogs
pnpm release             # build all, then publish changed packages
```

Releases are cut by hand and tagged per package with the full package name in
that package's own published scope (`<scope>/dsh-<name>@X.Y.Z`) — a bare
`vX.Y.Z` cannot name one of several packages. [RELEASING.md](RELEASING.md) is the operator runbook: the steps in
order, and what has to be verified before a version is public.
