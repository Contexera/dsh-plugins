# @contexera/dsh-jev

## 0.1.4

### Patch Changes

- 0b7c765: Classify an unserializable request before it is retried.

  `buildWireBody` returned the object to send and left `JSON.stringify` to the
  transport, so a parameter the vendor cannot represent — `NaN`, a `BigInt`, a
  cycle — surfaced as a transport failure and was retried three times, sending
  the request zero times and reporting a network error. Serialization now
  happens in `request`, and its failure is a `JevError` of kind `request`,
  which the retry policy does not cover.

## 0.1.3

### Patch Changes

- [中文](#cn-v0-1-3) | [English](#en-v0-1-3)

  <h3 id="cn-v0-1-3">中文</h3>

  **改了什么**

  - 应答解析改为校验 `JevAnswer` 声明的成员，而不只是信封和 `type` 标签。原先 `{ type: 'noul', noul: 'high' }` 会作为一条类型正确的成功结果交给调用方，直到阈值计算时才炸。
  - 现在逐项校验：`noul` 是 `0..1` 的有限数；`choice` 带字符串 `choice`、`0..1` 的有限概率对象与有限 `confidence`；`score` 带有限 `score`/`confidence`，以及值为 `0..1` 有限数的 `legend` 与 `probabilities`。成员缺失或形状不对即 `protocol` 失败，不重试。
  - 声明之外的字段照旧保留，厂商认为合法的应答不会被透传提供方拒绝。
  - 架构文档随 npm tarball 一起发布：README 链接的 `docs/` 此前不在 `files` 里，装包的人点进去是空路径。新增 `pnpm check:pack` 门禁按 `npm publish` 的方式打包并检查 README 与文档里的每个链接，CI 在 `pnpm -r build` 后运行，`pnpm release` 在 `changeset publish` 前运行。

  **兼容性**

  - 本包不声明 DSH peer，这条关系不变。
  - 入参、出参与配置键都不变；本次收紧的是畸形应答的处理。
  - `@contexera/dsh-context-continuity` 里指向本包的可选 peer 随本轮升到 `^0.1.3`。

  **验证**

  - 本地：`pnpm -r typecheck`、`pnpm -r test`（6 个文件 / 81 条测试）、`pnpm -r build` 全过，`check:peers` 与 `check:pack` 通过。

  ```sh
  npm i @contexera/dsh-jev@0.1.3
  ```

  <h3 id="en-v0-1-3">English</h3>

  **What changed**

  - The response parser now validates the members a `JevAnswer` declares, not just its envelope and `type` tag. `{ type: 'noul', noul: 'high' }` used to reach a caller as a typed success and only fail later, at the point a threshold was applied.
  - Each member is checked: `noul` is a finite number in `0..1`; `choice` carries a string `choice`, an object of finite probabilities in `0..1` and a finite `confidence`; `score` carries finite `score`/`confidence` plus `legend` and `probabilities` whose values are finite numbers in `0..1`. A missing or malformed member is a `protocol` failure, never retried.
  - Fields beyond the declaration are still kept, so a passthrough provider does not refuse an answer the vendor considers valid.
  - The architecture documents now ship in the npm tarball: the `docs/` pages the README links were not in `files`, so an installed reader followed a link to a path that did not exist. The new `pnpm check:pack` gate packs each package the way `npm publish` would and checks every link in a README or document; CI runs it after `pnpm -r build` and `pnpm release` runs it before `changeset publish`.

  **Compatibility**

  - This package declares no DSH peers; that relationship is unchanged.
  - Inputs, outputs and configuration keys are unchanged; what tightened is how malformed answers are handled.
  - The optional peer naming it inside `@contexera/dsh-context-continuity` moves to `^0.1.3` in this round.

  **Verification**

  - Local: `pnpm -r typecheck`, `pnpm -r test` (6 files / 81 tests) and `pnpm -r build` pass, and `check:peers` and `check:pack` hold.

## 0.1.2

### Patch Changes

- [中文](#cn-v0-1-2) | [English](#en-v0-1-2)

  <h3 id="cn-v0-1-2">中文</h3>

  **改了什么**

  - 包名迁到 `@contexera/dsh-jev`；`@wowyuarm/dsh-jev` 停在 0.1.1，已标记废弃并指向新名。
  - profile 行自己的 `id`（`jev`）、配置键与请求/应答的形状都不变，已有配置照用。

  **兼容性**

  - 本包不声明 DSH peer，这条关系不变。
  - `dsh-context-continuity` 里指向它的可选 peer 会在引擎自己的下一次发布中换成新名。

  **验证**

  - 本地：`pnpm -r typecheck`、`pnpm -r test`（6 个文件 / 54 条测试）、`pnpm -r build` 全过，`check:peers` 通过。

  ```sh
  npm i @contexera/dsh-jev@0.1.2
  ```

  <h3 id="en-v0-1-2">English</h3>

  **What changed**

  - The package publishes as `@contexera/dsh-jev`; `@wowyuarm/dsh-jev` stays at 0.1.1 and is deprecated in favour of it.
  - The profile row's own id (`jev`), its configuration keys, and the request/response shapes do not change, so existing configuration keeps working.

  **Compatibility**

  - This package declares no DSH peers; that relationship is unchanged.
  - The optional peer naming it inside `dsh-context-continuity` moves to the new name in the engine's own next release.

  **Verification**

  - Local: `pnpm -r typecheck`, `pnpm -r test` (6 files / 54 tests) and `pnpm -r build` pass, and `check:peers` holds.

  ```sh
  npm i @contexera/dsh-jev@0.1.2
  ```

## 0.1.1

### Patch Changes

[中文](#cn-v0-1-1) | [English](#en-v0-1-1)

<h3 id="cn-v0-1-1">中文</h3>

首个版本：Jev 判断 provider，只面向代码调用，不注册工具。

**内容**

- **Cordis service，不是工具**：`ctx.jev.decide({ state, questions, signal? })` 返回 vendor 原样的 `{ model, answers, usage }`。v1 不注册任何工具——判断由代码发起，不必唤醒主模型。
- **不做策略**：不设阈值、不做门控、不写 prompt 段。概率与置信照原样透传，取什么阈值是消费方拿自己的样本校准的事。
- **默认官方端点**：`apiBase` 默认 `https://api.typesafe.ai/v1`（路径 `/systemone`），`model` 默认钉版本 `jev-1.13.0` 而非别名。两者与密钥均可配置；密钥只从 `apiKey` 或 `apiKeyEnv` 读取，不进日志与错误文案。
- **失败语义**：七种类型化失败（`config` / `request` / `transport` / `timeout` / `http` / `protocol` / `cancelled`），最终失败即抛错，绝不返回编造的答案。重试只覆盖传输失败、超时、408、429、5xx，遵守 `retry-after` 且不越过 `maxRetryDelayMs`（默认 30000）；取消永不重试。
- **只声明真正依赖的 peer**：`@deepseek-ai/cordis ^4.0.1` 与 `schemastery ^3.18.1`，不绑定任何 `@deepseek-ai/dsh-*` 版本线。
- **问题与答案**：`noul` / `choice` / `score` 三种提问类型，`criteria` 按类型分（choice 是映射、score 是有序数组）；`noul` 答案没有 confidence 字段。请求形状在本地就校验，越界即 `request` 失败，不空跑一次往返。

**兼容性**

不声明任何 `@deepseek-ai/dsh-*` peer —— 不绑定 DSH 版本线，任何宿主线都装得上；只要求 `@deepseek-ai/cordis` 4.x 与 `schemastery` 3.x。

**验证**

本地：`check:peers`、typecheck、boundaries、54/54 测试（6 个 spec，传输注入离线打桩）、build 全绿。官方端点上的真调用已实测：三型问题一次调用 200、无效密钥 401 且只尝试一次、score 的 `criteria` 写成对象被本地校验拒绝。

```
npm i @wowyuarm/dsh-jev@0.1.1
```

<h3 id="en-v0-1-1">English</h3>

First release: a Jev decision provider for code, registering no tools.

**What it is**

- **A Cordis service, not a tool**: `ctx.jev.decide({ state, questions, signal? })` returns the vendor response verbatim as `{ model, answers, usage }`. v1 registers no tools — decisions are started by code, so the main model never has to wake up for one.
- **No policy**: no thresholds, no gating, no prompt section. Probabilities and confidence pass through as they arrive; picking a threshold is the consumer's job, calibrated against the consumer's own samples.
- **Official endpoint by default**: `apiBase` defaults to `https://api.typesafe.ai/v1` (path `/systemone`) and `model` to the pinned `jev-1.13.0` rather than an alias. Both, and the key, are configurable; the key is read only from `apiKey` or `apiKeyEnv` and never reaches logs or error messages.
- **Failure semantics**: seven typed failures (`config` / `request` / `transport` / `timeout` / `http` / `protocol` / `cancelled`), and a final failure throws instead of inventing an answer. Retries cover transport failures, timeouts, 408, 429, and 5xx only, honour `retry-after`, and stop at `maxRetryDelayMs` (default 30000); cancellation is never retried.
- **Only the peers it uses**: `@deepseek-ai/cordis ^4.0.1` and `schemastery ^3.18.1`, with no `@deepseek-ai/dsh-*` line declared.
- **Questions and answers**: the `noul` / `choice` / `score` question types, with `criteria` per type (a map for choice, an ordered array for score); a `noul` answer carries no confidence field. Requests are validated locally, so a malformed one fails as `request` instead of costing a round trip.

**Compatibility**

Declares no `@deepseek-ai/dsh-*` peer — no DSH line is claimed, so it installs on any host line; it requires only `@deepseek-ai/cordis` 4.x and `schemastery` 3.x.

**Verification**

Local: `check:peers`, typecheck, boundaries, 54/54 tests (6 specs, transport stubbed offline), and build all green. Real calls against the official endpoint: three question types in one call returned 200, an invalid key returned 401 after a single attempt, and a score `criteria` sent as an object was rejected by local validation.

```
npm i @wowyuarm/dsh-jev@0.1.1
```
