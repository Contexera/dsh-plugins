---
"@wowyuarm/dsh-context-continuity": minor
---

[中文](#cn-v0-2-0-gate) | [English](#en-v0-2-0-gate)

<h3 id="cn-v0-2-0-gate">中文</h3>

压力策略多了**第三条路**：长间隔相关性门控。隔了很久才回来、context 又还很大，宿主可以问一次 jev"这条输入和最近几轮接得上吗"；接不上就扣住这条输入、投一条**换代**指令，让模型写 handoff 并调 `context_rollover`，扣住的输入随新代交回。**没装 jev 就整条不启用，不是失败。**

**新的 pre-step 决策：`hold`**

`PressureStepDecision` 从三种变四种。`hold` 与 `reject` 必须分开：`hold` 说的是"这一步认领的消息被留下了，宿主得收好"，`reject` 说的是"这一步跑不了、也没东西可留"（硬上限走的就是后者，那些消息早被压过）。宿主拿 `reject` 的写法去处理 `hold` 会把用户输入丢掉。

**两个可选宿主成员**

门控由两个**可选**成员开关，缺任何一个就整条关掉——这是受支持的部署，不是故障：

```ts
relatednessFor: member => ({ input: pendingInputTextOf(member), recent: recentUserInputsOf(member) }),
judgeFor: member => ctx.jev,   // 任何有 decide(request) 的东西
```

`relatednessFor` 只能宿主给：这一步正在认领的 messages 是宿主自己的 `agent/pre-step` 入参。引擎负责问什么、怎么读答案——那是策略，不是传输。

**remedy 是换代，不需要压缩引擎**

指令让模型写 handoff 并调 `context_rollover`，因此**这个 scope 压不了 context 完全不是障碍**——压不动的 scope 恰恰是这条门控要照顾的。`compactionFor` 在这条路上不被查询；`releaseHold(subject)` 与 `PressureHoldOutcome` 随之删掉：换代路径上"压到了没有"这个判据没有意义。

**指令必须把扣住的输入引回去**

输入被扣住，就是为了让它开不出 step——代价是写 handoff 的模型**看不到这条请求**。handoff 是下一代的全部种子，种子里没有下一次请求，是这条 remedy 唯一可能比就地压缩更差的地方。所以指令引用扣住输入的原文（截前 4000 字符），并点名 `rolloverToolName`。

**扣件：与换代 latch 并列的第二个 latch**

`ContextContinuityCoordinator` 新增挂起状态：

- `holdClaimedInput(agent, messages)` —— **武装与扣留是一次调用**。捕获在没有 latch 时会被拒，所以分两次、顺序反了，丢的正好是这条 latch 要保的那条输入。
- `needsAdmissionGate(agent)` 现在对挂起也返回真：挂着的时候不能有后续 step 开起来。`isHoldingInput(agent)` 单独报告同一件事。
- **两个出口都由 coordinator 自己拥有，宿主一个都不用管。** 指令是作为 next-step 消息投进去的，所以 driver 会**单独**为它开一个 turn——那是模型写 handoff 的机会。一是换代落地（在那个 turn 里落地，或扣住的 turn 结束时已在飞）：挂起被清掉，扣住的输入随 `carriedInput` 进新代。二是没有换代：coordinator 把扣住的输入原样投回，并记一条"请求的换代没有发生"；投递等 driver 收敛，所以指令那个 turn 先独占跑完，而判据在**投递那一刻**再查一次——模型在指令 turn 里换代了，输入照样走换代。判据就是"有没有成功的 `context_rollover` 结果落地"（`isTransitioning` 报的就是它），不做 surface 前后比较。
- **换代被宿主拒绝，输入也照样交回。** 上面两条出口都以"换代真的执行了"为前提。`executeTransition` 拒绝时，输入已经被 drain 进那份不再存在的 plan——于是 coordinator 按同一条纪律把它交回去：等 driver 收敛，投递那一刻再查一次有没有换代；宿主失败后立刻重试换代，输入就跟着重试走，没有就原样投回上一代并记一条日志。这一条不只管扣件：任何为换代捕获的输入（排队的、被 pre-step 抢走的）都受它保护，宿主也就不必在拒绝前先把 `carriedInput` 吐出来。
- **挂起只覆盖被扣的那个 turn。** 这一点是硬的：宿主如果在压力策略**之前**查 `needsAdmissionGate`（Team 现有接线就是这么查的），挂起活过那个 turn 就会把唯一携带指令的 turn 也拒掉，指令永远到不了模型。所以挂起在扣住的那个 turn 结束时就被丢掉，输入仍只投一次。
- 因此 `releaseHeldInput` 从公开面撤掉，改成内部。前一版设计要求宿主在 turn 结束时手动释放，**忘了释放就会拒掉之后每一步**——那个硬风险现在不存在了。

**超时是自己兜的**

jev 自己的重试预算是按后台调用定的（默认 30s × 3），而这次调用在**起动一个 turn 的关键路径**上。引擎传自己的 signal（`judgeTimeoutMs`，默认 5s；被取消的调用 jev 不重试），**并且同时用 race 停止等待**——judge 不理 signal 也拖不住 pre-step。永远不会返回的 pre-step 就是一个永远跑不起来的 subject。

**间隔从日志读，不从内存读**

`SessionEvent.time` 是 Unix epoch 毫秒，引擎直接读 span 最新事件的时间。这样重启不会被当成半小时空档；整段没有事件时"测不出间隔"不算长间隔，门控不开。

**没换代的每一种都记一条**

接得上 / 判不出 / 超时 / 报错 / 答案不成形 / 没装 judge：都照常继续，**并且各记一条**。门控决定不换代，与门控根本没跑，不能长得一样。

**依赖形状**

`@wowyuarm/dsh-jev` 是**可选 peer**（`peerDependenciesMeta.optional`）+ 钉已发布版本 `0.1.1` 的 devDependency，**不是 workspace 链接**——装与不装都能加载本包。它同时是本包 `check-boundaries.mjs` 里**唯一**一条非 `@deepseek-ai/dsh-*` 例外（`ALLOWED_PACKAGES` 里带理由）。运行时零依赖：编译产物只有 `.d.ts` 引用它。

**阈值**

`DEFAULT_GATE_TOKENS = 128_000`、`DEFAULT_GATE_IDLE_MS = 1_800_000` 由本包导出，构造器第三个参数按策略覆盖。

**验证**

本地：`check:peers`、typecheck、boundaries、整仓 `-r test` / `-r typecheck` / `-r build` 全绿；本包 **291/291**（8 个文件；门控那版 286，上一版 279）。八条会变红的测试各做了一次变异验证，八条都确实变红：捕获守卫退回只认换代、`needsAdmissionGate` 忘掉挂起、turn 结束的兜底不投回、换代在飞时兜底也投回、投递时不再查换代、间隔下限不生效、指令不再引用扣住的输入、judge 调用不走自己的 deadline。第四条一开始**没被抓到**——当时没有测试覆盖"换代已排定但还没落地时又来了一个 turn 结束"，补了那条测试之后才变红。

换代失败交回输入另有五条测试，三次变异都确实变红：删掉交回调用，五条全红；去掉投递那一刻的换代复查，重试那条与既有的"换代在飞"那条红；把 `executeTransition` 挪回 `try` 外面，同步抛错那条红，同时冒出一次没人接的 rejection。

判据另有实测支撑：`SessionEvent.time` 见 `packages/core/session/src/types.ts:499`；pre-step 被拒也会落 `turn/end`（`packages/core/agent-loop/src/agent.ts` 的 `finally` 无条件 append，`reject` 走 `turnEnds = { kind: 'blocked' }`），所以兜底触发点确实可达；`Inbox.claim()` 先取 `next-step` 再取一条 `next-turn`，而 `steer` 投的正是 `next-step`（`agent-loop/src/inbox.ts:109`、`agent.ts:167`），所以指令那个 turn 会单独跑；可选 peer 不撞 release-age 门（本仓没有配 `minimumReleaseAge`），且 `check:peers` 只读 `@deepseek-ai/dsh-*`。

<h3 id="en-v0-2-0-gate">English</h3>

The pressure policy gains a **third path**: the long-gap relatedness gate. When a subject comes back to a still-large context after a long absence, the host may ask its judge once whether the arriving input continues the recent work. If it does not, the input is kept and one **rollover** instruction takes its place — the model writes a handoff and calls `context_rollover`, and the kept input arrives with the next generation. **With no judge installed the whole gate stays off — that is a deployment, not a failure.**

**A new pre-step decision: `hold`**

`PressureStepDecision` goes from three kinds to four. `hold` and `reject` must stay apart: `hold` says *the messages this step claimed are kept, so take care of them*, while `reject` says *this step cannot run and there is nothing to keep* — which is what the hard limit returns, its messages having already been reduced. Handling a `hold` the way a `reject` is handled drops the user's input.

**Two optional host members**

Two **optional** members switch the gate on; omit either and the whole gate is off — a supported deployment, not a fault:

```ts
relatednessFor: member => ({ input: pendingInputTextOf(member), recent: recentUserInputsOf(member) }),
judgeFor: member => ctx.jev,   // anything with decide(request)
```

Only a host can answer `relatednessFor`: the messages this step is admitting are its own `agent/pre-step` argument. What to ask and how to read the answer is the engine's, because that is policy rather than transport.

**The remedy is a rollover, and it needs no compaction engine**

The instruction asks for a handoff and a `context_rollover`, so a scope that cannot shorten its context in place is **no obstacle at all** — it is exactly the scope this gate is for. `compactionFor` is not consulted on this path, and `releaseHold(subject)` with `PressureHoldOutcome` are gone: on a rollover path, *did the reduction happen* is not a question with a meaning.

**The instruction must quote the held input back**

The input is held precisely so that it opens no step, and the price is that the model writing the handoff **cannot see the request the handoff is for**. The handoff is the whole seed of the next generation, and a seed written without knowing what arrives next is the one way this remedy can come out worse than compacting in place. The instruction therefore quotes the held input (its first 4000 characters) and names `rolloverToolName`.

**The hold: a second latch, beside the rollover latch**

`ContextContinuityCoordinator` gains held-step state:

- `holdClaimedInput(agent, messages)` — **arming and capturing are one call.** The capture is refused while no latch is armed, so doing these as two calls in the other order drops exactly the input the latch exists to preserve.
- `needsAdmissionGate(agent)` is now true for a hold too: nothing may open a step behind it. `isHoldingInput(agent)` reports the same fact on its own.
- **Both exits belong to the coordinator, and the host owns neither.** The instruction is steered as a next-step message, so the driver opens **one turn for it alone** — the model's chance to write the handoff. The first exit is a rollover landing (in that turn, or already in flight when the held turn ends): the hold is cleared and the kept input travels into the new generation as `carriedInput`. The second is no rollover: the coordinator hands the kept input back itself and logs that the requested rollover did not happen; that delivery waits for the driver to converge, so the instruction's turn runs to itself first, and the test is re-applied **at delivery time** — a model that rolls over during the instruction turn still gets the input through the swap. The judgement is *did a successful `context_rollover` result land* — which is what `isTransitioning` reports — with no before/after surface comparison.
- **A rejected swap hands the input back as well.** Both exits above assume the swap actually ran. When `executeTransition` rejects, the input has already been drained into a plan that no longer exists, so the coordinator hands it back by the same discipline: wait for the driver to converge and re-test for a rollover **at delivery time** — a host that retries the swap right away takes the input with it, otherwise it goes back to the previous generation unchanged with a log line. This is not the hold's privilege alone: any input captured for a swap (queued, or claimed by a racing pre-step) is protected, and a host never has to hand `carriedInput` back out itself after a rejection.
- **The hold covers the held turn only.** This one is load-bearing: a host that checks `needsAdmissionGate` **before** its pressure policy — which is what the Team wiring does today — would reject the one turn carrying the instruction if the hold outlived the held turn, and the instruction would never reach a model. The hold is therefore dropped when the held turn ends, and the input is still delivered exactly once.
- `releaseHeldInput` therefore leaves the public surface and becomes internal. The earlier design asked the host to release the hold at the end of the turn, and **a host that forgot rejected every later step**; that hard risk is now gone.

**The deadline is the engine's own**

The judge's retry budget is sized for a background call (30s × 3 by default), and this call is on the path that starts a turn. The engine passes its own signal (`judgeTimeoutMs`, default 5s — a cancelled call is never retried by the judge) **and races it**, so a judge that ignores the signal cannot hold the pre-step open. A pre-step that never returns is a subject that never runs.

**The gap is read from the log, not from memory**

`SessionEvent.time` is Unix epoch milliseconds, and the engine reads the newest span event's own timestamp. A restart therefore cannot look like a half-hour absence; a span with no event has no measurable gap and is not gated.

**Every ungated outcome is recorded**

Related, undecided, timed out, failed, malformed answer, no judge: the step continues as usual, and **each is logged**. A gate that decided not to roll over must not look like one that never ran.

**Dependency shape**

`@wowyuarm/dsh-jev` is an **optional peer** (`peerDependenciesMeta.optional`) plus a devDependency pinned to the published `0.1.1`, and **not a workspace link** — the package loads with or without it. It is also the **only** non-`@deepseek-ai/dsh-*` entry in this package's `check-boundaries.mjs` (`ALLOWED_PACKAGES`, with its reason). The runtime dependency is zero: only `.d.ts` references it.

**Thresholds**

`DEFAULT_GATE_TOKENS = 128_000` and `DEFAULT_GATE_IDLE_MS = 1_800_000` are exported here, and the third constructor argument overrides them per policy.

**Verification**

Local: `check:peers`, typecheck, boundaries, and repository-wide `-r test` / `-r typecheck` / `-r build` all green; **291/291** tests in this package (8 files; 286 at the gate, 279 before). Eight tests that can go red were mutation-checked, and all eight went red: reverting the capture guard to rollover-only, dropping the hold from `needsAdmissionGate`, a turn-end fallback that never delivers, a fallback that also fires while a rollover is in flight, a delivery that stops re-checking for a rollover, disabling the idle floor, an instruction that stops quoting the held input, and awaiting the judge without the policy deadline. The fourth was **not** caught at first — nothing covered a second turn end arriving after the swap was scheduled but before it landed — and only went red once that test was added.

The hand-back on a rejected swap has five tests of its own, and three mutations went red: deleting the hand-back call (all five), dropping the rollover re-check at delivery (the retry test and the pre-existing in-flight one), and moving the `executeTransition` call back outside the `try` (the synchronous-throw test, plus an unhandled rejection).

Three judgements were verified rather than assumed: `SessionEvent.time` at `packages/core/session/src/types.ts:499`; that a rejected pre-step still appends `turn/end` (the `finally` in `packages/core/agent-loop/src/agent.ts` appends it unconditionally, with `reject` leaving `turnEnds = { kind: 'blocked' }`), so the fallback's trigger is genuinely reachable; and that the instruction's turn runs alone, because `Inbox.claim()` takes `next-step` before a `next-turn` message and `steer` targets `next-step` (`agent-loop/src/inbox.ts:109`, `agent.ts:167`). The optional peer does not trip the release-age gate (no `minimumReleaseAge` is configured here) while `check:peers` reads only `@deepseek-ai/dsh-*`.
