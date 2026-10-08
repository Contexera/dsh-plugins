# @contexera/dsh-context-continuity

## 0.3.0

### Minor Changes

- [中文](#cn-v0-3-0) | [English](#en-v0-3-0)

  <h3 id="cn-v0-3-0">中文</h3>

  DSH 线不变，仍是 `>=0.2.0-rc.1 <0.2.1`。这一版把「压缩摘要写什么」收回本包：导出一份通用模板，并给出用它的压缩后端；`context_compact` 新增可选参数 `summary`，主体可以自己写这份替换文本。

  **改了什么**

  - **新增通用模板 `DEFAULT_COMPACTION_TEMPLATE`（含分节清单 `DEFAULT_COMPACTION_SECTIONS`）**：七节，按「后来者拿不回来的东西」排序，并要求每条事实标明**验证过**还是**仅听说**、说清**欠谁什么、谁在等我**。这套排序来自实测：133 次真实压缩里，三个 code 向分节占了约 55% 篇幅、Next Step 只占 2%，41% 的摘要完全没提谁在等这个主体。
  - **新增压缩后端 `ContinuityCompactionEngine`（子路径 `@wowyuarm/dsh-context-continuity/compaction-engine`）**：挂在原本挂 `@deepseek-ai/dsh-compaction-basic` 的位置，模板才真正生效；只覆盖 `summarize()`，其余全部继承。措辞的改法是在子类里覆盖 `protected template`，不走配置表。该子路径**必须默认导出**——预设按 `name:` 挂插件时 loader 取的是默认导出，只给具名导出会让那一行**静默失效**。
  - **`context_compact` 新增可选参数 `summary`**：主体在同一次调用里写下替换文本，不额外多一轮；省略或留空时行为与之前完全一致。压力通知随之改口径——本包自动监听是关的，这条通知是唯一的软触发，而旧措辞等于让主体在判断最值钱的那一刻把措辞交回引擎。
  - **三处工具描述与提示语的判断修正**：`context_checkpoint` 的触发条件从「接下来危险吗」改成「这个 context 我以后会想回来吗」；`context_rollover` 说明带 `checkpointRef` 回返是「锚点前缀逐字打开 + handoff 照样写」，不是丢弃；`context_compact` 说明摘要不是主体写的；`jobsNote` 把只有宿主能兑现的「还有 job 在跑就拒绝换代」从引擎描述里摘出来，宿主传 `''` 即可丢掉。
  - **不需要改上游**：`summarize()` 的返回值就是替换内容，且其类型明确允许一个不发起 LLM 调用的写手。代价：这份文本要短于被替换的那段，否则被拒（工具会说上下文未变，可写短再试）。

  **兼容性**

  - 纯新增：两个新导出、一个新子路径、一个新**可选**参数。**不挂这个类就完全没有行为变化**，继续挂原版 `compaction-basic` 仍受支持。
  - 新增 peer `@deepseek-ai/dsh-compaction-basic`（同一条 DSH 线）；DSH 线不动，不涉及重新认证。
  - 两条跟着 Harness 版本走的耦合，失效都是**静默**的：子类复述了 `summarize()` 的调用形状；主体自写的摘要靠 Session 对象同一性送达引擎（上游若包装或重建 agent 就退回模板）。例外与理由记在 `AGENTS.md`。

  **验证**

  Local: `check:peers`、typecheck、`check:boundaries`、**324/324** 测试（10 文件）、build 全绿，对着钉住的 `0.2.0-rc.1`；artifact 42 条、34 条运行时相对 import 全落 tarball。测试钉住：末条指令就是本包模板，且**绝不出现原版模板的招牌分节**；交出的 `summary` 原样返回且**一次 stream 请求都不发**；这份文本**只为那一次尝试存在**；超限被拒且引擎根本不被调用；**构建产物经 loader 取法取出的是那个类**。

  ```
  npm i @wowyuarm/dsh-context-continuity@0.3.0
  ```

  <h3 id="en-v0-3-0">English</h3>

  The DSH line is unchanged at `>=0.2.0-rc.1 <0.2.1`. This version takes "what a compaction summary should say" back into this package: it exports a general template and ships a compaction backend that uses it, and `context_compact` gains an optional `summary` so the subject can write that replacement text itself.

  **What changed**

  - **A general template, `DEFAULT_COMPACTION_TEMPLATE` (with `DEFAULT_COMPACTION_SECTIONS`)**: seven sections ordered by what a successor cannot reconstruct, asking for every fact to be marked **verified or merely trusted** and for **what is owed to whom, and who is waiting**. The ordering is measured: across 133 real compactions, three code-facing sections took about 55% of every summary while Next Step took 2%, and 41% never mentioned who was waiting on the subject.
  - **A compaction backend, `ContinuityCompactionEngine` (subpath `@wowyuarm/dsh-context-continuity/compaction-engine`)**: mount it where a host would otherwise mount `@deepseek-ai/dsh-compaction-basic` — that is what makes the template take effect. Only `summarize()` is overridden; everything else is inherited. Wording changes by overriding a `protected template` in a subclass, not by a config key. The subpath **must default-export** the class: a preset mounts by `name:` and the loader takes the default export, so a named export alone would make that line **silently do nothing**.
  - **`context_compact` gains an optional `summary`**: the subject writes the replacement text in the same call, with no extra round trip; omitting it or passing it blank behaves exactly as before. The pressure notice follows: this package's automatic listeners are off, so the notice is the only soft trigger, and it used to hand the wording back to the engine at exactly the moment the subject's judgement is worth most.
  - **Judgement fixed in three tool descriptions and the notice**: `context_checkpoint`'s trigger moves from "is what comes next risky" to "is this a context I might want back"; `context_rollover` now says a `checkpointRef` return opens on the anchor's prefix word for word with the handoff still written on top, rather than discarding; `context_compact` says the summary is not the subject's; and `jobsNote` lifts a promise only a host can honour out of the engine description, so a host can drop it with `''`.
  - **No upstream change is needed**: `summarize()`'s return value is the replacement content, and its type explicitly admits a summarizer that issues no LLM call. The cost: that text must be shorter than the stretch it replaces, or the replacement is refused (the tool says the context is unchanged, and the subject can retry shorter).

  **Compatibility**

  - Purely additive: two new exports, one new subpath, one new **optional** parameter. **Mounting this class is the only way to see a behavior change**, and the stock `compaction-basic` row remains supported.
  - One new peer, `@deepseek-ai/dsh-compaction-basic`, on the same DSH line. The line does not move, so no re-certification is involved.
  - Two couplings to Harness releases, both failing **silently**: the subclass restates `summarize()`'s call shape, and a subject-written summary reaches the engine through Session object identity (a wrapped or rebuilt agent falls back to the template). The exception and its reason are recorded in `AGENTS.md`.

  **Verification**

  Local: `check:peers`, typecheck, `check:boundaries`, **324/324** tests (10 files) and build all green against the pinned `0.2.0-rc.1`; 42 artifact entries with all 34 runtime relative imports inside the tarball. Tests pin that the final instruction is this package's template and that **the stock template's signature sections never appear**; that a supplied `summary` returns verbatim with **zero stream requests issued**; that the text **exists for that one attempt only**; that an oversized summary is refused **with the engine never called**; and that **the built module unwraps to that class through the loader's own rule**.

  ```
  npm i @wowyuarm/dsh-context-continuity@0.3.0
  ```

## 0.2.1

### Patch Changes

- [中文](#cn-v0-2-1-status-rows) | [English](#en-v0-2-1-status-rows)

  <h3 id="cn-v0-2-1-status-rows">中文</h3>

  DSH 线不变，仍是 `>=0.2.0-rc.1 <0.2.1`。这一版只动 `context_status` 的锚点表：只差 anchor 摘要的相邻行合成一行。

  **改了什么**

  - **`context_status` 的锚点表把只差 anchor 摘要的相邻行合成一行**：这一行给出行数、共同的 label / source / kind / 尺寸 / topics / 原因，并列出它覆盖的每一个 anchor 摘要，所以「每一行都点得出名字」这条保证对整段仍然成立。
  - **多 topic 的上下文天然会攒出这种串**：每条进入上下文的 Team fact 各留一个边界锚点，而它们的 label、尺寸、topics、原因完全一样，逐行重复只增加长度、不增加信息。
  - **可恢复的行永不合并**：`ref:` 只能出现在可恢复行上，一行一个，合并段在可恢复行处断开。

  **兼容性**

  - 无宿主可见的契约变化：工具名、导出与 peer 都和 `0.2.0` 一样，DSH 线也不动。变的只有模型读到的锚点表文本——单行照旧，成串的非可恢复行现在写成一行。

  **验证**

  Local: `check:peers`、typecheck、boundaries、**295/295** 测试（8 文件）与 build 全绿，对着钉住的 `0.2.0-rc.1`；artifact 检查 36 条、29 条运行时相对 import 全落 tarball。

  ```
  npm i @wowyuarm/dsh-context-continuity@0.2.1
  ```

  <h3 id="en-v0-2-1-status-rows">English</h3>

  The DSH line is unchanged at `>=0.2.0-rc.1 <0.2.1`. This version only changes how `context_status` lays out its anchor table: adjacent rows that differ only by their anchor digest fold into one line.

  **What changed**

  - **The `context_status` anchor table folds adjacent rows that differ only by their anchor digest into one line**: that line gives the row count, the shared label / source / kind / sizes / topics / reason, and every anchor digest it covers, so the guarantee that a row can be named still holds for the run as a whole.
  - **A multi-topic context accumulates such runs by nature**: every fact that entered it leaves one boundary anchor, and those rows share a label, sizes, topics and reason exactly, so repeating them line by line adds length without information.
  - **A restorable row is never merged**: the citable `ref:` form appears on restorable rows only, one per row, and a run is cut around every one of them.

  **Compatibility**

  - No host-visible contract change: the tool name, the exports and the peers are the same as `0.2.0`, and the DSH line does not move. What changes is the anchor-table text a model reads — a single row renders as before, and a run of non-restorable rows now renders as one line.

  **Verification**

  Local: `check:peers`, typecheck, boundaries, **295/295** tests (8 files) and build all green against the pinned `0.2.0-rc.1`; the artifact check covers 36 entries, with all 29 runtime relative imports resolving inside the tarball.

  ```
  npm i @wowyuarm/dsh-context-continuity@0.2.1
  ```

## 0.2.0

### Minor Changes

- [中文](#cn-v0-2-0) | [English](#en-v0-2-0)

  <h3 id="cn-v0-2-0">中文</h3>

  DSH 线不变，仍是 `>=0.2.0-rc.1 <0.2.1`。这一版新增一个就地压缩工具、一条长间隔门控，并把 `context_timeline` 改名为 `context_status`。

  **改了什么**

  - **新增模型可见工具 `context_compact`（无参数）**：在当前 Session 内就地压短上下文。安全区间由引擎挑：不从开头的 `system/message` 起压、不碰最新的 `user/message` 及其后任何消息、两端都退到不切开「工具调用 / 工具结果」的位置；有 meter 时按它给最近的一段定价并原样留下（默认保留 32K）。日志仍是 append-only：摘要换掉的是模型看到的东西，不是记录下来的东西。没有安全区间时报 `nothing`；该 scope 没挂压缩引擎则回 `status: 'unavailable'` 并说明原因——「不挂 compaction」是一种受支持的组装方式。引擎抛错时报 `context_compact failed: <原因>`，并说明这个 context 变没变；若 `replaceGeneration` 已经前进，则提醒先重新读一遍再决定。压力提醒的默认动作随能力走：能压缩时 notice 把 `context_compact` 当默认动作、`context_rollover` 留给真正的换代；不能压缩时文本与 `0.1.6` 逐字相同，绝不点名一个该 scope 没有的工具。
  - **长间隔相关性门控**：隔了很久才回来、context 又还很大时，宿主可以问一次 jev「这条输入和最近几轮接得上吗」；接不上就扣住这条输入、投一条换代指令，让模型写 handoff 并调 `context_rollover`，扣住的输入随新代交回。**没装 jev 就整条不启用——是部署，不是故障。** 门控由两个**可选**宿主成员开关，缺一个就整条关掉：

    ```ts
    relatednessFor: member => ({ input: pendingInputTextOf(member), recent: recentUserInputsOf(member) }),
    judgeFor: member => ctx.jev,   // 任何有 decide(request) 的东西
    ```

  - **新的 pre-step 决策 `hold`**：`PressureStepDecision` 从三种变四种。`hold` 与 `reject` 必须分开——`hold` 说「这一步认领的消息被留下了，宿主得收好」，`reject` 说「这一步跑不了、也没东西可留」；拿 `reject` 的写法处理 `hold` 会把用户输入丢掉。两个出口都由 coordinator 自己拥有：换代落地 → 挂起清掉、扣住的输入随新代交回；没换代（含宿主拒绝换代）→ 输入原样投回并记一条日志，投递那一刻再查一次有没有换代。交回时按当时的宿主绑定重新定目标，绝不投进一个已经不再代表这个主体的 Agent；挂起只覆盖被扣的那个 turn。
  - **判据与代价**：间隔从日志读（`SessionEvent.time`，Unix epoch 毫秒），重启不会被当成空档。judge 调用在起动一个 turn 的关键路径上，所以引擎传自己的 deadline（`judgeTimeoutMs`，默认 5s）并同时用 race 停止等待。接得上 / 判不出 / 超时 / 报错 / 答案不成形 / 没装 judge 都照常继续，**并各记一条**——「门控决定不换代」与「门控根本没跑」不能长得一样。这条 remedy 是换代，不需要压缩引擎，`compactionFor` 在这条路上不被查询。阈值 `DEFAULT_GATE_TOKENS = 128_000`、`DEFAULT_GATE_IDLE_MS = 1_800_000` 由本包导出。
  - **`context_timeline` 改名为 `context_status`**：同一个工具改名换描述，不新开一个。描述不再锁在「我已经决定要回退」上，改成按情形触发：`Call it at a boundary, after a long gap, or when you are unsure where you stand.`；`context_rollover`、`context_checkpoint` 的描述与拒绝文案里的旧名一并改掉。输出首行现在给数，锚点行一个字没动：

    ```
    Context: 149,763 / 200,000 handoff / 256,000 hard limit
    Composition (heuristic): system ~8K · tools ~11K · messages ~131K
    Compact now: about 118K compactible; keeps the last ~33K verbatim
    ```

  **兼容性**

  - **`ContinuityToolAdapter` 新增必填成员 `compactionFor(agent)`**，返回该 agent 所在 scope 的 `{ engine, meter?, retainTokens? }` 或 `undefined`（返回 `undefined` 即保持今天的行为）。寻址是宿主的事：预设经 `isolate` 挂载的服务读不到 `ctx.get('compaction')`。
  - **工具名变了，这是宿主可见的破坏性改动**：自己复制过 timeline 工具的宿主（例如 Agent Team）必须跟着改名，否则模型手上那个工具还叫 `context_timeline`，而引擎的描述已经指向 `context_status`。注册句柄 `ContinuityTools.timeline` → `ContinuityTools.status`；`ContinuityToolAdapter.timeline()` 不变。
  - **`ContextTimeline` 加两个可选字段**：`composition`（`systemTokens` / `toolsTokens` / `messagesTokens`，启发式估算；`toolsTokens` 是工具 schema，不是工具结果）与 `compactible`（`compactibleTokens` / `retainedTailTokens`）。新增导出 `compactibleNow(session, scope)`，按 `context_compact` 自己的选区定价——别自己拿「用量 − 保留尾」去减。字段缺席时不渲染对应行，更不编造 `0`；不供新数据的宿主除首行与锚点计数行外，输出与 `0.1.6` 一致。
  - **peer**：新增 `@deepseek-ai/dsh-compaction`（`>=0.2.0-rc.1 <0.2.1`，与其余 DSH peer 同线）；`@wowyuarm/dsh-jev` 是可选 peer（devDependency 钉已发布的 `0.1.1`，不是 workspace 链接），装与不装都能加载本包。DSH 线本身与 `0.1.6` 相同。0.x 下以上按 minor 计入 `0.2.0`。

  **验证**

  本地：`check:peers`、typecheck、boundaries、**293/293** 测试（8 个文件）、build 全绿，跑在钉住的 `0.2.0-rc.1` 上。会变红的关键边界做了变异验证（把实现改坏、对应测试确实变红）：`context_compact` 的三条选区边界、`compactibleNow` 把「无法定价」当成 `0`、状态面丢掉渲染行，以及门控的八条。CI 在 linux 与 windows 两条 lane 均通过（提交 `6abf5de`）。

  ```
  npm i @wowyuarm/dsh-context-continuity@0.2.0
  ```

  <h3 id="en-v0-2-0">English</h3>

  The DSH line is unchanged at `>=0.2.0-rc.1 <0.2.1`. This release adds an in-place compaction tool and a long-gap gate, and renames `context_timeline` to `context_status`.

  **What changed**

  - **New model-facing tool `context_compact` (no arguments)**: it shortens the context in place, inside the current Session. The engine picks the safe stretch: it never starts on a leading `system/message`, never reaches the newest `user/message` or anything after it, and retreats off either edge rather than splitting a tool call from its result; with a meter it prices the recent tail and keeps it verbatim (32K retained by default). The log stays append-only — the summary replaces what the model sees, not what was recorded. When no stretch is safe it reports `nothing`; a scope that mounts no compaction engine answers `status: 'unavailable'` with a reason, because mounting no compaction is a supported composition. An engine rejection reads `context_compact failed: <reason>` and says whether this context moved — when `replaceGeneration` already advanced, it says to read the context again before deciding. The pressure notice's default action follows the capability: when the scope can compact, `context_compact` becomes the default and `context_rollover` is kept for a genuine page turn; when it cannot, the text is byte-identical to `0.1.6` and never names a tool the scope lacks.
  - **The long-gap relatedness gate**: after a long absence with a still-large context, the host may ask its judge once whether the arriving input continues the recent work. If it does not, the input is held and one rollover instruction takes its place — the model writes a handoff, calls `context_rollover`, and the kept input arrives with the next generation. **With no judge installed the whole gate stays off — a deployment, not a failure.** Two **optional** host members switch it on, and omitting either turns the whole gate off:

    ```ts
    relatednessFor: member => ({ input: pendingInputTextOf(member), recent: recentUserInputsOf(member) }),
    judgeFor: member => ctx.jev,   // anything with decide(request)
    ```

  - **A new pre-step decision, `hold`**: `PressureStepDecision` goes from three kinds to four. `hold` and `reject` must stay apart — `hold` says the messages this step claimed are kept, so take care of them; `reject` says this step cannot run and there is nothing to keep. Handling a `hold` the way a `reject` is handled drops the user's input. Both exits belong to the coordinator: the rollover lands and the hold clears, with the kept input carried into the next generation; no rollover — a host-rejected one included — and the input is delivered back verbatim with a log line, re-checking at delivery time whether a rollover actually happened. At hand-back the target is re-resolved from the host binding of that moment, never delivered to an agent that no longer represents the subject, and the hold covers only the turn it was claimed in.
  - **Evidence and cost**: the gap is read from the log (`SessionEvent.time`, Unix epoch milliseconds), so a restart is not mistaken for an absence. The judge call sits on the critical path of starting a turn, so the engine passes its own deadline (`judgeTimeoutMs`, 5s by default) and races the wait as well. Related, undecidable, timed out, errored, malformed, or no judge at all: each continues as before and **each is logged** — a gate that decided against a rollover must not look like a gate that never ran. The remedy is a rollover, so it needs no compaction engine and does not consult `compactionFor`. Thresholds `DEFAULT_GATE_TOKENS = 128_000` and `DEFAULT_GATE_IDLE_MS = 1_800_000` are exported by the package.
  - **`context_timeline` is renamed `context_status`**: one tool renamed and reworded, not a second tool. The description no longer waits on a decided intention — it opens on the situation: `Call it at a boundary, after a long gap, or when you are unsure where you stand.` The old name is gone from the `context_rollover` and `context_checkpoint` prose and rejections too. The first lines now carry the numbers; the anchor rows are unchanged:

    ```
    Context: 149,763 / 200,000 handoff / 256,000 hard limit
    Composition (heuristic): system ~8K · tools ~11K · messages ~131K
    Compact now: about 118K compactible; keeps the last ~33K verbatim
    ```

  **Compatibility**

  - **`ContinuityToolAdapter` gains a required member, `compactionFor(agent)`**, returning that agent's scope as `{ engine, meter?, retainTokens? }` or `undefined` — returning `undefined` preserves today's behavior. Resolving it is the host's job: a service a preset mounted behind `isolate` is not visible to `ctx.get('compaction')`.
  - **The tool name changed, and that is a host-visible breaking change**: a host that keeps its own copy of the timeline tool (the Agent Team does) must follow the rename, or the tool the model can call is still `context_timeline` while the engine's prose points at `context_status`. The registration handle `ContinuityTools.timeline` becomes `ContinuityTools.status`; `ContinuityToolAdapter.timeline()` is unchanged.
  - **`ContextTimeline` gains two optional fields**: `composition` (`systemTokens` / `toolsTokens` / `messagesTokens`, a heuristic split; `toolsTokens` prices the tool schemas offered to the model, not tool results) and `compactible` (`compactibleTokens` / `retainedTailTokens`). New export `compactibleNow(session, scope)` prices that pair by running the selection `context_compact` performs — do not subtract "usage − retained tail" yourself. An absent field renders no line, and no `0` is invented; a host that supplies neither field sees the `0.1.6` output apart from the first line and the new anchor-count line.
  - **Peers**: new `@deepseek-ai/dsh-compaction` (`>=0.2.0-rc.1 <0.2.1`, the same line as the other DSH peers); `@wowyuarm/dsh-jev` is an optional peer (devDependency pinned at the published `0.1.1`, not a workspace link), so the package loads with or without it. The DSH line itself is unchanged from `0.1.6`. At 0.x all of the above rides `0.2.0` as a minor.

  **Verification**

  Local: `check:peers`, typecheck, boundaries, **293/293** tests (8 files) and build all green, against the pinned `0.2.0-rc.1`. The boundaries that can go red were mutation-checked — break the implementation and the matching test does go red: the three bounds of `context_compact`'s range selection, pricing "cannot be measured" as `0` in `compactibleNow`, dropping the composition line from the render, and the gate's eight. CI passed on both the linux and windows lanes (commit `6abf5de`).

  ```
  npm i @wowyuarm/dsh-context-continuity@0.2.0
  ```

## 0.1.6

### Patch Changes

- [中文](#cn-v0-1-6) | [English](#en-v0-1-6)
  
  <h3 id="cn-v0-1-6">中文</h3>
  
  适配 DeepSeek Harness `0.2.0-rc.1`。
  
  **改了什么**
  
  - **DSH 线整条搬到 `0.2.0-rc.1`**：七个 `@deepseek-ai/dsh-*` peer 现在声明 `>=0.2.0-rc.1 <0.2.1`，开发依赖钉在 `0.2.0-rc.1` —— 声明的那条线就是测试实跑的那条线。`@deepseek-ai/cordis` 仍是 `^4.0.1`，`dsh-session-query` 仍是可选 peer。
  - **不再跨世代解析**：引擎只声明这一条线，所以装在同一世代的宿主上时，会话包用宿主自己那一份，而不是把另一世代的 peer 拷贝嵌进安装树。
  - **npm 元数据指向 monorepo**：`repository` 现在指向 `wowyuarm/dsh-plugins` 的 `packages/context-continuity`。
  
  **兼容性**
  
  `src/` 与导出一个字节没动，宿主侧不用改代码。宿主仍停在 `0.1.7-rc.x` 时，npm 会报 peer 冲突告警，引擎作为依赖仍可安装。
  
  **验证**
  
  本地：`check:peers`、typecheck、boundaries、214/214 测试（7 个文件）、build 全绿，全部跑在钉住的 `0.2.0-rc.1` 上。
  
  ```
  npm i @wowyuarm/dsh-context-continuity@0.1.6
  ```
  
  <h3 id="en-v0-1-6">English</h3>
  
  Adapts to DeepSeek Harness `0.2.0-rc.1`.
  
  **What changed**
  
  - **The DSH line moved as a whole to `0.2.0-rc.1`**: the seven `@deepseek-ai/dsh-*` peers now declare `>=0.2.0-rc.1 <0.2.1`, pinned in devDependencies to `0.2.0-rc.1` — the line the tests actually run against. `@deepseek-ai/cordis` stays `^4.0.1` and `dsh-session-query` stays an optional peer.
  - **No more cross-generation resolution**: the engine declares this one line, so on a host of the same generation the session packages come from the host's own copy instead of another generation's peer copy nested inside the install tree.
  - **npm metadata points at the monorepo**: `repository` now points at `packages/context-continuity` of `wowyuarm/dsh-plugins`.
  
  **Compatibility**
  
  `src/` and the exports are untouched, so hosts need no code change. A host still on `0.1.7-rc.x` sees npm peer-conflict warnings; the engine still installs as a dependency.
  
  **Verification**
  
  Local: `check:peers`, typecheck, boundaries, 214/214 tests (7 files), and build all green, run against the pinned `0.2.0-rc.1`.
  
  ```
  npm i @wowyuarm/dsh-context-continuity@0.1.6
  ```
