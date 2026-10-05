---
"@wowyuarm/dsh-context-continuity": minor
---

[中文](#cn-v0-3-0-engine) | [English](#en-v0-3-0-engine)

<h3 id="cn-v0-3-0-engine">中文</h3>

新增 `ContinuityCompactionEngine`：用本包的通用模板写摘要的压缩后端。宿主把它挂在原本挂 `@deepseek-ai/dsh-compaction-basic` 的位置即可。

**为什么需要一个引擎类**

上一笔导出了通用模板，但**模板说了不算**——摘要由宿主挂载的引擎写，而那个引擎写的是它自己那套面向通用编码会话的模板。**模板只有从引擎内部才能生效**，所以本包自己出一个引擎。只覆盖 `summarize()`；选区间、保留策略、定价、压缩锁、触发策略、替换事务全部继承。

**为什么重新发起那次调用，而不是委托父类**

父类会**在收到的输入之后**再追加它自己那段指令。若把本包模板追加好再交给父类，就是**两段指令一起发**，而模型听最后一条——结果父类那套静默获胜、覆盖率归零。所以这次调用由本类自己发起。**代价说清楚**：那次辅助调用的形状在这里被复述了一遍，上游改这段序列就得跟着改。这是"拥有措辞"买下的耦合，也是本包唯一认识具体 Harness 后端的文件。

**改措辞的方式是继承，不是配置**

Cordis 会用插件继承来的 `Config` 模式校验配置，而本包不拥有那个模式（要加一个 key 就得为此依赖 schema 库）。所以模板是 `protected` 字段，宿主想要不同措辞就覆盖它：

```ts
class HouseStyle extends ContinuityCompactionEngine {
  protected override readonly template = '...'
}
```

**边界例外**

本包的白名单原有唯一例外（jev）。这是第二条，理由记在 `ALLOWED_PACKAGES` 与 `AGENTS.md`：`dsh-compaction-basic` 是 Harness 的包、不是宿主包（"host 无关"禁的是导入宿主），且只被 `compaction-engine.ts` 引用。**买下的风险是实打实的**：这个子类跟着 Harness 版本走，上游一改 `summarize()` 的形状它就会断，而不是优雅降级。

**兼容性**

纯新增：新增一个导出与一个子路径导出 `@wowyuarm/dsh-context-continuity/compaction-engine`，新增 peer `@deepseek-ai/dsh-compaction-basic`（同 DSH 那条线）。**不挂这个类就完全没有行为变化**——宿主挂原版 `compaction-basic` 仍受支持。0.x 下按 minor 升到 `0.3.0`。

**验证**

typecheck 0 错、`check:boundaries` 通过、build 产出 `lib/compaction-engine.js` 与 `.d.ts`、本包测试全套通过（10 个文件）。新增 `compaction-engine.spec.ts` 5 例，钉住：末条指令就是本包模板；**请求里绝不出现原版模板的招牌分节**（`super.summarize()` 回归时会红）；子类覆盖字段确实生效；未配置摘要目标时按会话路由；调用的 `purpose` 与返回信封正确。构造期还实测到一处真问题并修掉：模板若当成后端配置键会在父类的严格校验里抛 `unknown key`。

<h3 id="en-v0-3-0-engine">English</h3>

Adds `ContinuityCompactionEngine`: a compaction backend that writes summaries with this package's general template. A host mounts it where it would otherwise mount `@deepseek-ai/dsh-compaction-basic`.

**Why an engine class is needed**

The previous change exported a general template, but **a template on its own decides nothing** — summaries are written by whichever engine a host mounts, and that engine writes them from its own coding-session wording. **The template can only take effect from inside the engine**, so this package now ships one. Only `summarize()` is overridden; selection, retention, pricing, the compaction lock, trigger policy and the replacement transaction are all inherited.

**Why the call is re-issued rather than delegated**

The base appends its own directive *after* the input it is handed. Appending this package's template and then delegating would send **both directives**, and a model follows the last one — so the base's wording would win silently and the override would do nothing. This class therefore issues the call itself. **The cost is stated plainly**: the shape of that auxiliary call is restated here, so a change to the base's summarization sequence has to be mirrored. That coupling is what owning the wording buys, and it is why this is the one file in the package that knows a concrete Harness backend.

**Wording is changed by subclassing, not by config**

Cordis validates a plugin's config against the `Config` schema it inherits, and this package does not own that schema — adding a key would mean depending on the schema library purely for it. The template is therefore a `protected` field a host overrides:

```ts
class HouseStyle extends ContinuityCompactionEngine {
  protected override readonly template = '...'
}
```

**Boundary exception**

This package's import allowlist had one exception (jev). This is the second, with its reason recorded in `ALLOWED_PACKAGES` and `AGENTS.md`: `dsh-compaction-basic` is a Harness package, not a host package (the host-agnostic rule forbids importing a *host*), and it is referenced by `compaction-engine.ts` alone. **The risk bought is real**: this subclass tracks Harness releases, and a change to `summarize()`'s shape breaks it rather than degrading gracefully.

**Compatibility**

Purely additive: one new export plus a subpath export, `@wowyuarm/dsh-context-continuity/compaction-engine`, and a new peer, `@deepseek-ai/dsh-compaction-basic`, on the same DSH line. **Mounting this class is the only way to see a behavior change** — a host that keeps the stock `compaction-basic` row remains supported. At 0.x this is a minor bump to `0.3.0`.

**Verification**

Typecheck clean, `check:boundaries` passes, build emits `lib/compaction-engine.js` and its `.d.ts`, and the package's full suite passes across 10 files. The new `compaction-engine.spec.ts` adds 5 cases pinning that the final instruction is this package's template; that **the stock template's signature sections never appear in the request** (a `super.summarize()` regression turns it red); that a subclass override takes effect; that an unconfigured target follows the conversation's route; and that the call's `purpose` and returned envelope are right. Construction also surfaced a real defect, now fixed: passing the template as a backend config key throws the base's strict `unknown key` validation.
