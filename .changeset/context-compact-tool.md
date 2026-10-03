---
"@wowyuarm/dsh-context-continuity": minor
---

[中文](#cn-v0-1-7) | [English](#en-v0-1-7)

<h3 id="cn-v0-1-7">中文</h3>

新增第四个模型可见工具 `context_compact`：**在当前 Session 内**就地压短上下文。

**内容**

- **`context_compact`（无参数）**：由引擎挑出可安全替换的区间——绝不从开头的 `system/message` 起压，绝不触及最新的 `user/message` 及其后任何消息，两端都会退到不切开「工具调用 / 工具结果」的位置；有 meter 时按它给最近的一段（默认保留 32K）定价并原样留下。日志仍是 append-only：摘要换掉的是模型看到的东西，不是记录下来的东西。结果写明替换了几条、约多少 token、以及压缩后的测量总量；没有安全区间时报 `nothing` 而不是失败。
- **不可用是结果，不是失败**：调用不带 agent，或该 scope 没挂引擎时，工具回 `status: 'unavailable'` 并说明原因——"不挂 compaction" 是一种受支持的组装方式，模型读到的是发生了什么，而不是被静默吞掉。
- **失败会说清这个 context 变没变**：引擎抛错时抛 `context_compact failed: <原因>`，后接 `This context is unchanged.`；若持久 surface 的 `replaceGeneration` 已经前进，则改说「可能已经有替换落在本 context 上，先重新读一遍再决定」。
- **压力提醒的默认动作随能力走**：scope 能压缩时，notice 把 `context_compact` 当作默认动作，`context_rollover` 留给真正的换代（主动清空、从更早的锚点继续、或换 session）；不能压缩时文本与 `0.1.6` 逐字相同，且绝不点名一个该 scope 没有的工具。

**兼容性**

`ContinuityToolAdapter` 新增**必填**成员 `compactionFor(agent)`，返回该 agent 所在 scope 的 `{ engine, meter?, retainTokens? }` 或 `undefined`（返回 `undefined` 即可保持今天的行为）。寻址是宿主的事：预设经 `isolate` 挂载的服务读不到 `ctx.get('compaction')`。0.x 下按 minor 升到 `0.1.7`。新增 peer `@deepseek-ai/dsh-compaction`（`>=0.2.0-rc.1 <0.2.1`），与其余 DSH peer 同线。

**验证**

本地：`check:peers`、typecheck、boundaries、241/241 测试（8 个文件，含新增的 `compaction.spec.ts` 15 例与工具侧 8 例）全绿。选区间用真实 Session surface 断言，三条边界（不从 system 起压、不吞最新指令、配对退让）各做了一次变异验证：把对应实现改坏，测试确实变红。

<h3 id="en-v0-1-7">English</h3>

Adds a fourth model-facing tool, `context_compact`: shorten the context **in place, inside the current Session**.

**What it is**

- **`context_compact` takes no arguments.** The engine picks the stretch that is safe to replace: it never starts on a leading `system/message`, never reaches the newest `user/message` or anything after it, and retreats off either edge rather than splitting a tool call from its result. With a meter it prices the recent tail and keeps it verbatim (32K retained by default). The log stays append-only — the summary replaces what the model sees, not what was recorded. The result names how many messages were replaced, roughly what they cost, and the measured total afterward; when no stretch is safe it reports `nothing` instead of failing.
- **An unavailable scope is a result, not a failure.** A call carrying no agent, or a scope that mounts no engine, answers `status: 'unavailable'` with a reason: mounting no compaction is a supported composition, so the model reads what happened instead of a silent no-op.
- **A failure says whether this context moved.** An engine rejection surfaces as `context_compact failed: <reason>` followed by `This context is unchanged.`; when the durable surface's `replaceGeneration` already advanced, it instead says a replacement may already be on this context and to read it again before deciding.
- **The pressure notice's default action follows the capability.** When the scope can compact, the notice makes `context_compact` the default and keeps `context_rollover` for a genuine page turn (a deliberate clearing, a return to an earlier anchor, another session). When it cannot, the text is byte-identical to `0.1.6` and no compaction tool is named — a subject is never told to call a tool its scope lacks.

**Compatibility**

`ContinuityToolAdapter` gains a **required** member, `compactionFor(agent)`, returning that agent's scope as `{ engine, meter?, retainTokens? }` or `undefined` (returning `undefined` preserves today's behavior). Resolving it is the host's job: a service a preset mounted behind `isolate` is not visible to `ctx.get('compaction')`. At 0.x this is a minor bump to `0.1.7`. New peer `@deepseek-ai/dsh-compaction` (`>=0.2.0-rc.1 <0.2.1`), on the same line as the other DSH peers.

**Verification**

Local: `check:peers`, typecheck, boundaries, and 241/241 tests (8 files, including the new `compaction.spec.ts` with 15 cases and 8 tool-level cases) all green. The range selection is asserted against real Session surfaces, and each of its three bounds was mutation-checked: breaking the implementation turns the matching test red.
