# dsh-plugins

Monorepo for the published [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugins under the `@wowyuarm` scope. Each package is published to npm
independently; the repo only unifies tooling, dependency management, and release.

## Packages

| Package | npm |
| --- | --- |
| [`packages/channel-gateway`](packages/channel-gateway) | [`@wowyuarm/dsh-channel-gateway`](https://www.npmjs.com/package/@wowyuarm/dsh-channel-gateway) |
| [`packages/context-continuity`](packages/context-continuity) | [`@wowyuarm/dsh-context-continuity`](https://www.npmjs.com/package/@wowyuarm/dsh-context-continuity) |

## Development

```bash
pnpm install
pnpm -r typecheck   # strict TypeScript, no emit
pnpm -r test        # package boundary check + unit tests
pnpm -r build       # emit each package's lib/
```

Run a single package with a filter, e.g. `pnpm --filter @wowyuarm/dsh-context-continuity test`.

## Releasing

Versioning is independent per package via [changesets](https://github.com/changesets/changesets).

```bash
pnpm changeset           # record intended version bumps
pnpm version-packages    # apply bumps + changelogs
pnpm release             # build all, then publish changed packages
```
