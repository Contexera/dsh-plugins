---
"@contexera/dsh-context-continuity": patch
---

[中文](#cn-engine-scope) | [English](#en-engine-scope)

<h3 id="cn-engine-scope">中文</h3>

**改了什么**

- 包名迁到 `@contexera/dsh-context-continuity`；`@wowyuarm/dsh-context-continuity` 停在 0.3.0，已标记废弃并指向新名。
- 可选的 `dsh-jev` peer 换成 `@contexera/dsh-jev`（0.1.2 已在该名下发布），请求与应答的形状不变。
- 除命名外没有行为变化：导出、子路径（`/compaction-engine`）与 DSH peer 区间都照旧。

**兼容性**

- DSH 声明线不变，仍是 `>=0.2.0-rc.1 <0.2.1`。
- `dsh-jev` 是可选 peer：不装也能跑；装了的话，长间隔判定从此走新名那个包。

**验证**

- 本地：`pnpm -r typecheck`、`pnpm -r test`（10 个文件 / 324 条测试）、`pnpm -r build` 全过，`check:peers` 通过。

```sh
npm i @contexera/dsh-context-continuity@0.3.1
```

<h3 id="en-engine-scope">English</h3>

**What changed**

- The package publishes as `@contexera/dsh-context-continuity`; `@wowyuarm/dsh-context-continuity` stays at 0.3.0 and is deprecated in favour of it.
- The optional `dsh-jev` peer moves to `@contexera/dsh-jev` (published under that name at 0.1.2); request and response shapes do not change.
- Nothing but the naming changes: exports, the `/compaction-engine` subpath and the DSH peer range stay as they are.

**Compatibility**

- The DSH line is unchanged: `>=0.2.0-rc.1 <0.2.1`.
- `dsh-jev` is an optional peer — the engine runs without it; with it installed, the long-gap decision goes through the newly named package.

**Verification**

- Local: `pnpm -r typecheck`, `pnpm -r test` (10 files / 324 tests) and `pnpm -r build` pass, and `check:peers` holds.

```sh
npm i @contexera/dsh-context-continuity@0.3.1
```
