---
"@wowyuarm/dsh-context-continuity": minor
---

[中文](#cn-v0-1-7-gate) | [English](#en-v0-1-7-gate)

<h3 id="cn-v0-1-7-gate">中文</h3>

压力策略多了**第三条路**：长间隔相关性门控。隔了很久才回来、context 又还很大，宿主可以问一次 jev"这条输入和最近几轮接得上吗"；接不上就扣住这条输入、投一条压缩指令，让模型先压，压完把输入还回去。**没装 jev 就整条不启用，不是失败。**

**新的 pre-step 决策：`hold`**

`PressureStepDecision` 从三种变四种。`hold` 与 `reject` 必须分开：`hold` 说的是"这一步认领的消息被留下了，宿主得收好"，`reject` 说的是"这一步跑不了、也没东西可留"（硬上限走的就是后者，那些消息早被压过）。宿主拿 `reject` 的写法去处理 `hold` 会把用户输入丢掉。

**两个可选宿主成员**

门控由两个**可选**成员开关，缺任何一个就整条关掉——这是受支持的部署，不是故障：

```ts
relatednessFor: member => ({ input: pendingInputTextOf(member), recent: recentUserInputsOf(member) }),
judgeFor: member => ctx.jev,   // 任何有 decide(request) 的东西
```

`relatednessFor` 只能宿主给：这一步正在认领的 messages 是宿主自己的 `agent/pre-step` 入参。引擎负责问什么、怎么读答案——那是策略，不是传输。

**扣件：同代内的第二个 latch**

`ContextContinuityCoordinator` 新增压缩挂起状态，与换代的 latch 并列：

- `holdClaimedInput(agent, messages)` —— **武装与扣留是一次调用**。捕获在没有 latch 时会被拒，所以分两次、顺序反了，丢的正好是这条 latch 要保的那条输入。
- `needsAdmissionGate(agent)` 现在对挂起也返回真：挂着的时候不能有后续 step 开起来。
- `releaseHeldInput(agent)` —— 唯一的出口，返回扣住的输入。宿主在**那一 turn 结束时**调用，压没压成都要调：**一直不解的挂起会拒掉之后每一步**。
- 换代照旧扣件复用：换代落地时挂起被清掉，扣住的输入随 `carriedInput` 进新代。

**判决归策略**

`releaseHold(subject)` 返回 `{ reduced }`：策略在扣住时记下 `surfaceFor`，释放时用与硬上限**同一套** `reductionProven` 判断。宿主不必自己重算证明。没记到挂起时返回 `undefined`，并且按"没测到"报，不按"成功"报。

**超时是自己兜的**

jev 自己的重试预算是按后台调用定的（默认 30s × 3），而这次调用在**起动一个 turn 的关键路径**上。引擎传自己的 signal（`judgeTimeoutMs`，默认 5s；被取消的调用 jev 不重试），**并且同时用 race 停止等待**——judge 不理 signal 也拖不住 pre-step。永远不会返回的 pre-step 就是一个永远跑不起来的 subject。

**间隔从日志读，不从内存读**

`SessionEvent.time` 是 Unix epoch 毫秒，引擎直接读 span 最新事件的时间。这样重启不会被当成半小时空档；整段没有事件时"测不出间隔"不算长间隔，门控不开。

**没压成的每一种都记一条**

接得上 / 判不出 / 超时 / 报错 / 答案不成形 / 没装 judge / 这个 scope 压不了：都照常继续，**并且各记一条**。门控决定不压，与门控根本没跑，不能长得一样。

**依赖形状**

`@wowyuarm/dsh-jev` 是**可选 peer**（`peerDependenciesMeta.optional`）+ 钉已发布版本 `0.1.1` 的 devDependency，**不是 workspace 链接**——装与不装都能加载本包。它同时是本包 `check-boundaries.mjs` 里**唯一**一条非 `@deepseek-ai/dsh-*` 例外（`ALLOWED_PACKAGES` 里带理由）。运行时零依赖：编译产物只有 `.d.ts` 引用它。

**阈值**

`DEFAULT_GATE_TOKENS = 128_000`、`DEFAULT_GATE_IDLE_MS = 1_800_000` 由本包导出，构造器第三个参数按策略覆盖。

**验证**

本地：`check:peers`、typecheck、boundaries、整仓 `-r test` / `-r typecheck` / `-r build` 全绿；本包 **279/279**（8 个文件，上一版 251），新增 28 条。五条会变红的测试各做了一次变异验证，五条都确实变红：捕获守卫退回只认换代、`needsAdmissionGate` 忘掉挂起、间隔下限不生效、释放永远声称压过、judge 调用不走自己的 deadline。判据另有实测支撑：`SessionEvent.time` 见 `packages/core/session/src/types.ts:499`；可选 peer 不撞 release-age 门（本仓没有配 `minimumReleaseAge`），且 `check:peers` 只读 `@deepseek-ai/dsh-*`。

<h3 id="en-v0-1-7-gate">English</h3>

The pressure policy gains a **third path**: the long-gap relatedness gate. When a subject comes back to a still-large context after a long absence, the host may ask its judge once whether the arriving input continues the recent work. If it does not, the input is kept, one compaction instruction takes its place, and the input is handed back once the compaction is done. **With no judge installed the whole gate stays off — that is a deployment, not a failure.**

**A new pre-step decision: `hold`**

`PressureStepDecision` goes from three kinds to four. `hold` and `reject` must stay apart: `hold` says *the messages this step claimed are kept, so take care of them*, while `reject` says *this step cannot run and there is nothing to keep* — which is what the hard limit returns, its messages having already been reduced. Handling a `hold` the way a `reject` is handled drops the user's input.

**Two optional host members**

Two **optional** members switch the gate on; omit either and the whole gate is off — a supported deployment, not a fault:

```ts
relatednessFor: member => ({ input: pendingInputTextOf(member), recent: recentUserInputsOf(member) }),
judgeFor: member => ctx.jev,   // anything with decide(request)
```

Only a host can answer `relatednessFor`: the messages this step is admitting are its own `agent/pre-step` argument. What to ask and how to read the answer is the engine's, because that is policy rather than transport.

**The hold: a second latch, in the same generation**

`ContextContinuityCoordinator` gains compaction-hold state beside the rollover latch:

- `holdClaimedInput(agent, messages)` — **arming and capturing are one call.** The capture is refused while no latch is armed, so doing these as two calls in the other order drops exactly the input the latch exists to preserve.
- `needsAdmissionGate(agent)` is now true for a hold too: nothing may open a step behind it.
- `releaseHeldInput(agent)` — the one exit, returning the kept input. The host calls it at the end of that turn whether or not the compaction happened: **a hold that is never released rejects every later step.**
- Rollover reuses the same capture: a swap clears the hold and carries the kept input into the new generation as `carriedInput`.

**The verdict belongs to the policy**

`releaseHold(subject)` returns `{ reduced }`: the policy records `surfaceFor` when it holds, and releases through the same `reductionProven` the hard limit uses. A host does not re-derive the proof. With no hold recorded it returns `undefined`, and reports *not measured* rather than assuming success.

**The deadline is the engine's own**

The judge's retry budget is sized for a background call (30s × 3 by default), and this call is on the path that starts a turn. The engine passes its own signal (`judgeTimeoutMs`, default 5s — a cancelled call is never retried by the judge) **and races it**, so a judge that ignores the signal cannot hold the pre-step open. A pre-step that never returns is a subject that never runs.

**The gap is read from the log, not from memory**

`SessionEvent.time` is Unix epoch milliseconds, and the engine reads the newest span event's own timestamp. A restart therefore cannot look like a half-hour absence; a span with no event has no measurable gap and is not gated.

**Every ungated outcome is recorded**

Related, undecided, timed out, failed, malformed answer, no judge, no compaction capability in scope: the step continues as usual, and **each is logged**. A gate that decided not to compact must not look like one that never ran.

**Dependency shape**

`@wowyuarm/dsh-jev` is an **optional peer** (`peerDependenciesMeta.optional`) plus a devDependency pinned to the published `0.1.1`, and **not a workspace link** — the package loads with or without it. It is also the **only** non-`@deepseek-ai/dsh-*` entry in this package's `check-boundaries.mjs` (`ALLOWED_PACKAGES`, with its reason). The runtime dependency is zero: only `.d.ts` references it.

**Thresholds**

`DEFAULT_GATE_TOKENS = 128_000` and `DEFAULT_GATE_IDLE_MS = 1_800_000` are exported here, and the third constructor argument overrides them per policy.

**Verification**

Local: `check:peers`, typecheck, boundaries, and repository-wide `-r test` / `-r typecheck` / `-r build` all green; **279/279** tests in this package (8 files; 251 before), 28 of them new. Five tests that can go red were mutation-checked, and all five went red: reverting the capture guard to rollover-only, dropping the hold from `needsAdmissionGate`, disabling the idle floor, claiming every released hold was reduced, and awaiting the judge without the policy deadline. Two judgements were verified rather than assumed: `SessionEvent.time` at `packages/core/session/src/types.ts:499`, and that the optional peer does not trip the release-age gate (no `minimumReleaseAge` is configured here) while `check:peers` reads only `@deepseek-ai/dsh-*`.
