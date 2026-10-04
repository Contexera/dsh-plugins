# @wowyuarm/dsh-context-continuity

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
