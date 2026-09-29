# @wowyuarm/dsh-jev

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
