---
"@wowyuarm/dsh-context-continuity": minor
---

[中文](#cn-v0-3-0-engine) | [English](#en-v0-3-0-engine)

<h3 id="cn-v0-3-0-engine">中文</h3>

新增 `ContinuityCompactionEngine`：用本包的通用模板写摘要的压缩后端。宿主把它挂在原本挂 `@deepseek-ai/dsh-compaction-basic` 的位置即可。`context_compact` 同时新增可选参数 `summary`，**主体可以自己写这份替换文本**。

**为什么需要一个引擎类**

上一笔导出了通用模板，但**模板说了不算**——摘要由宿主挂载的引擎写，而那个引擎写的是它自己那套面向通用编码会话的模板。**模板只有从引擎内部才能生效**，所以本包自己出一个引擎。只覆盖 `summarize()`；选区间、保留策略、定价、压缩锁、触发策略、替换事务全部继承。

**主体自己写摘要（`context_compact(summary)`）**

压缩可能因主体的调用而开始，也可能**在主体毫无机会参与时**被强行开始，而**「谁来写摘要」在两种情况下答案不同**：

- **主体请求压缩**（`context_compact`）：它清楚这段里什么不能丢，所以**直接把替换文本写在同一次调用里**，不额外多一轮。
- **在主体没有机会参与时被强行压缩**（硬上限、或 provider 拒收过长请求）：这时只能由引擎按模板写——**这就是模板永远不能撤掉的原因**。

`summary` 省略或留空时行为与之前完全一致，引擎照旧按模板写。

**压力通知现在明确要主体自己写**

本包的**自动压缩监听是关掉的**（Team 预设那行是 `auto: false`），所以「该压缩了」这个软触发**只有压力通知一处**。通知原来只说「调用 `context_compact`」，于是主体很自然地把措辞交回给引擎——**恰恰在它自己的判断最值钱的那一刻**。现在通知改成：

> Finish the current atomic action: call `context_compact` with a summary you write yourself, to shorten this generation in place — your recent work stays verbatim and you keep working here — which is the default. Only you can say what in the replaced stretch has to survive; omitting it lets the engine write one, which is what happens when a reduction is forced on you. …

通知总长仍在原测试卡住的 1200 字符内（实测约 767）。**「通知会提这个参数」与「工具确实有它」不会错位**：两者出自同一个包、同一个版本，而通知只在主体确实有压缩工具时才提它（`canCompact`）。

**为什么工具描述里那份清单不换成模板原文**

模板是写给**压缩引擎**的（"Condense the conversation ABOVE"、以及"不要提到这次摘要请求"这类规则）；主体要写的是**自己的检查点**，套用引擎的口吻只会更差。所以主体那侧保留自己的分节说明，两份文本**意图相同、受众不同**。

**为什么这不需要改上游**

上游 `CompactionEngine.summarize()` 的**返回值就是替换掉那段上下文的内容**，而且它的返回类型**明确允许一个不发起 LLM 调用的写手**（原文：*"an unmarked template, remote, or other summarizer"*，`llmStreamCall?: never`）。所以主体写的文本按**未标记**结果交回：事务不会伪称发生过一次并不存在的调用。**代价**：这份文本仍要短于被替换的那段，否则替换被拒——这是个可恢复的失败（工具会说上下文未变），主体可以写短些再试一次。

**这份文本怎么从工具走到引擎**

`summarize()` 只拿到重放后的输入与 agent，没有别的入参，所以主体写的摘要得**带外**送到引擎。通道是 `pending-summary.ts`：按 **Session 对象**（不是 session id，`agent.session` 是同一个只读实例）弱引用键控，**由发起那次调用的工具在 `finally` 里清除**，而不是由读方消费——因为一次尝试可能多次摘要，而**失败的尝试绝不能把一份陈旧摘要留给下一次自动压缩**。它留在这里而不是做成跨包契约，是因为两端都属于本包。

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

**子路径必须默认导出这个类**

**预设按 `name:` 挂插件，而 loader 取的是模块的默认导出**（`vendor/loader/src/config/entry.ts`：`exports.default ?? exports`，结果交给只接受函数/类/`{ apply }` 的注册表）。所以 `@wowyuarm/dsh-context-continuity/compaction-engine` **必须默认导出**，只有具名导出的话，那一行会**静默地什么也不做**。原版 `dsh-compaction-basic` 正是这么导的。有一条测试专门钉住这件事（它复现 loader 的取法）。

**兼容性**

纯新增：新增一个导出与一个子路径导出 `@wowyuarm/dsh-context-continuity/compaction-engine`，新增 peer `@deepseek-ai/dsh-compaction-basic`（同 DSH 那条线），`context_compact` 新增一个**可选**参数。**不挂这个类就完全没有行为变化**——宿主挂原版 `compaction-basic` 仍受支持，`summary` 不传时行为也和以前一样。0.x 下按 minor 升到 `0.3.0`。

**验证**

typecheck 0 错、`check:boundaries` 通过、build 产出 `lib/compaction-engine.js` 与 `.d.ts`、本包测试全套 **324/324 通过**（10 个文件）。`compaction-engine.spec.ts` 9 例，钉住：末条指令就是本包模板；**请求里绝不出现原版模板的招牌分节**（`super.summarize()` 回归时会红）；子类覆盖字段确实生效；未配置摘要目标时按会话路由；调用的 `purpose` 与返回信封正确；**交出 `summary` 时原样返回该文本、且一次 stream 请求都不发**（连路由仍照常报告）；**构建产物经 loader 取法取出的是那个类**（只留具名导出就会红）。`tools.spec.ts` 新增 4 例，钉住：参数表只有 `summary` 一项；这份文本**只为这一次尝试存在**，成功、无可压缩区间、失败三条路径都不留残留；省略时不留；超限摘要被拒且**引擎根本不被调用**。`pressure.spec.ts` 新增 2 例，钉住：通知要主体自己写、并说清省略意味着什么；**没有压缩工具的那条路径绝不提这个参数**。构造期还实测到一处真问题并修掉：模板若当成后端配置键会在父类的严格校验里抛 `unknown key`。

**文档**

`README.md` / `README.zh.md` 两处（工具说明、它怎么工作、接入方式）、`docs/integration.md` 新增 **seam 10「压缩后端」**（挂法、为什么必须默认导出、为什么模板永不撤掉、主体自写的通道与一次性、两份文本两种受众），并改掉 seam 6 里「`context_compact` 不接受参数」那句；`docs/principles.md` 的 P8 补上"写什么由主体决定、模板是没有主体在场时的兜底"。

<h3 id="en-v0-3-0-engine">English</h3>

Adds `ContinuityCompactionEngine`: a compaction backend that writes summaries with this package's general template. A host mounts it where it would otherwise mount `@deepseek-ai/dsh-compaction-basic`. `context_compact` also gains an optional `summary` parameter, so **the subject can write that replacement text itself**.

**Why an engine class is needed**

The previous change exported a general template, but **a template on its own decides nothing** — summaries are written by whichever engine a host mounts, and that engine writes them from its own coding-session wording. **The template can only take effect from inside the engine**, so this package now ships one. Only `summarize()` is overridden; selection, retention, pricing, the compaction lock, trigger policy and the replacement transaction are all inherited.

**The subject writes the summary (`context_compact(summary)`)**

Compaction can start because the subject asked for it, or **be forced on it at a moment when it has no chance to take part**, and **"who writes the summary" has a different answer in each case**:

- **The subject asks for it** (`context_compact`): it knows what in that stretch must not be lost, so it **writes the replacement text in the same call** — no extra round trip.
- **It is forced on the subject** (the hard limit, or a provider refusing an oversized request): no subject can take part at that moment, so the engine writes from the template — **which is why the template can never be removed**.

Omitting `summary`, or passing it blank, behaves exactly as before: the engine writes from the template.

**The pressure notice now asks the subject to write it**

**This package's automatic compaction listeners are off** (the Team preset's row is `auto: false`), so the pressure notice is the **only** soft trigger that says "compact now". The notice used to say only "call `context_compact`", so a subject would naturally hand the wording back to the engine — **at exactly the moment its own judgement is worth most**. It now reads:

> Finish the current atomic action: call `context_compact` with a summary you write yourself, to shorten this generation in place — your recent work stays verbatim and you keep working here — which is the default. Only you can say what in the replaced stretch has to survive; omitting it lets the engine write one, which is what happens when a reduction is forced on you. …

The notice still fits inside the 1200-character bound the existing test pins (about 767 measured). **"The notice asks for this argument" and "the tool has it" cannot drift apart**: both come from this package in one version, and the notice mentions the tool only when the subject really has it (`canCompact`).

**Why the tool's own section list is not the template text**

The template is written for a **compaction engine** ("Condense the conversation ABOVE", and rules like "do not mention this summarization request"); a subject writes **its own checkpoint**, and adopting the engine's voice would only make that worse. So the subject keeps its own section wording: two texts with the **same intent and different audiences**.

**Why this needs no upstream change**

Upstream `CompactionEngine.summarize()`'s **return value is the content that replaces the stretch**, and its result type **explicitly admits a summarizer that issues no LLM call** (*"an unmarked template, remote, or other summarizer"*, `llmStreamCall?: never`). Subject-written text is therefore handed back as an **unmarked** result: the transaction never claims a call that did not happen. **The cost**: that text still has to be shorter than the stretch it replaces, or the replacement is refused — a recoverable failure (the tool says the context is unchanged) that the subject can retry shorter.

**How the text reaches the engine**

`summarize()` receives only the replayed input and the agent, so a subject-written summary has to arrive **out of band**. The channel is `pending-summary.ts`: a weak map keyed by the **Session object** (not the session id — `agent.session` is one stable readonly instance) and **cleared in a `finally` by the call that offered it**, not consumed by the reader — because one attempt may summarize more than once, and **a failed attempt must never leave a stale summary for the next automatic compaction to pick up**. It lives here rather than in a shared contract because both ends belong to this package.

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

**The subpath must default-export the class**

**A preset mounts a plugin by `name:`, and the loader takes a module's default export** (`vendor/loader/src/config/entry.ts`: `exports.default ?? exports`, handed to a registry that accepts only a function, a class, or `{ apply }`). So `@wowyuarm/dsh-context-continuity/compaction-engine` **must default-export the class**; with a named export alone that preset line would **silently do nothing**. The stock `dsh-compaction-basic` exports its engine the same way. A test pins this by reproducing the loader's own unwrap.

**Compatibility**

Purely additive: one new export plus a subpath export, `@wowyuarm/dsh-context-continuity/compaction-engine`, a new peer, `@deepseek-ai/dsh-compaction-basic`, on the same DSH line, and one new **optional** parameter on `context_compact`. **Mounting this class is the only way to see a behavior change** — a host that keeps the stock `compaction-basic` row remains supported, and behavior with no `summary` is unchanged. At 0.x this is a minor bump to `0.3.0`.

**Verification**

Typecheck clean, `check:boundaries` passes, build emits `lib/compaction-engine.js` and its `.d.ts`, and the package's full suite passes **324/324 across 10 files**. `compaction-engine.spec.ts` (9 cases) pins that the final instruction is this package's template; that **the stock template's signature sections never appear in the request** (a `super.summarize()` regression turns it red); that a subclass override takes effect; that an unconfigured target follows the conversation's route; that the call's `purpose` and returned envelope are right; that **a supplied `summary` comes back verbatim with zero stream requests issued** (the route is still reported); and that **the built module unwraps to that class through the loader's own rule** (a named export alone turns it red). `tools.spec.ts` adds 4 cases pinning that the parameter table holds `summary` alone; that the text **exists for that one attempt only** — nothing is left behind on the success, no-safe-range, or failure path; that omitting it leaves nothing; and that an oversized summary is rejected **with the engine never called**. `pressure.spec.ts` adds 2 cases pinning that the notice asks for a subject-written summary and states what omitting it means, and that **the path with no compaction tool never mentions the argument**. Construction also surfaced a real defect, now fixed: passing the template as a backend config key throws the base's strict `unknown key` validation.

**Documentation**

`README.md` and `README.zh.md` (the tool list, how it works, how to adopt it), a new **seam 10, "the compaction backend"**, in `docs/integration.md` (the mount, why the default export matters, why the template is never removable, the one-attempt channel for a subject-written summary, and the two texts' two audiences), the seam 6 line that said `context_compact` takes no arguments, and P8 in `docs/principles.md` (what the checkpoint says is the subject's choice; the template is the fallback for when no subject is present).
