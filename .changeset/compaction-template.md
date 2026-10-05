---
"@wowyuarm/dsh-context-continuity": minor
---

[中文](#cn-v0-3-0) | [English](#en-v0-3-0)

<h3 id="cn-v0-3-0">中文</h3>

新增导出的**通用压缩摘要模板** `DEFAULT_COMPACTION_TEMPLATE`（连同分节清单 `DEFAULT_COMPACTION_SECTIONS`）。

**为什么要给默认值**

一次压缩里，"压哪一段"本来就是这个包的事（四条边界都在 `compaction.ts`），而"摘要写什么"却被整个交给了引擎：`compactRegion(start, end, agent, signal)` 的四个参数没有位置放模板，引擎配置表里也没有模板字段。于是摘要的形状由**具体引擎**决定——默认那份是为通用编码会话写的，问的是文件、代码与修复。这个包导出一份通用模板，是让"摘要应当保住什么"有一个**与引擎无关的默认答案**。

**新模板保什么**

七节，按"后来者拿不回来的东西"排序：目标与当前动作 / 已确立的事实 / 未了的环与义务 / 决策与约束 / 外部副作用 / 工作材料 / 下一步。两条要求是**具名**的，不靠模型自觉：

- **每条事实标明"验证过"还是"仅听说"**；
- **说清欠谁什么、谁在等我**。

分节骨架本身就是可调的部分，所以模板是**一段完整文本**而不是分节列表——锁死骨架等于把下面这份实测结论冻进包里。

**这份排序来自实测，不是偏好**

取本机 133 次真实压缩（其中 125 次来自 Team Member 会话，跨度 2026-08-15 → 2026-10-05）统计：三个 code 向分节（Files and Code / Key Technical Concepts / Errors and Fixes）吃掉约 **55%** 篇幅，**Next Step 只占 2%**；而"决策理由 / 验证状态 / 义务"这三类最不可重建的信息，全部挤在 `Critical Context` 这个模糊兜底节里——它只占 16% 篇幅，却是各项占比最高的（验证 70%、义务 67%、决策理由 46%）。另有 **41%** 的摘要完全没有提到谁在等这个 Member。

**用不用取决于宿主**

本包不改变任何现有行为：新导出是**纯新增**。摘要由宿主挂载的引擎写，接缝是那个引擎类上的 `summarize()` 钩子；因此**宿主可以继续用引擎自带模板，也可以读这份默认值**。挂不挂、读不读，是组装时的选择，不是这里能强制的——所以这次只提供默认值，不改执笔方、不碰触发机制。

**兼容性**

新增两个导出，无参数、无 peer 变化、无行为变化。0.x 下按 minor 升到 `0.3.0`。

**验证**

本地：typecheck 0 错、`check:boundaries` 通过、build 正常产出 `compaction-template.js`、测试 **300/300 全绿**（9 个文件）。新增 `compaction-template.spec.ts` 5 例，钉住"每个声明的分节都真的被要求且顺序一致"，以及上面两条具名要求存在——将来精简模板时掉了这两条，测试会红。

<h3 id="en-v0-3-0">English</h3>

Adds an exported **general-purpose compaction template**, `DEFAULT_COMPACTION_TEMPLATE` (with its section list, `DEFAULT_COMPACTION_SECTIONS`).

**Why a default belongs here**

A compaction has two halves. Which stretch may be replaced is already this package's decision — all four bounds live in `compaction.ts` — while what the summary says was handed wholly to the engine: none of `compactRegion(start, end, agent, signal)`'s four parameters can carry a template, and the engine's own config table has no template field. The summary's shape therefore came from whichever engine was mounted, and the stock one is written for a general coding session: it asks for files, code and fixes. Exporting a template here gives "what a summary must preserve" an answer that does not depend on the engine.

**What the new template preserves**

Seven sections, ordered by what a successor cannot reconstruct: objective and current action, established facts, open loops and obligations, decisions and constraints, external side effects, working material, next step. Two requirements are **named** rather than left to habit:

- **mark every fact as verified or as merely trusted**, and
- **state what is owed to whom, and who is waiting**.

The section skeleton is the part worth tuning, so the template is **one complete text** rather than a list of sections; freezing the skeleton here would freeze the finding below into the package.

**The ordering is measured, not preferred**

Across 133 real compactions on this machine — 125 of them from Team Member sessions, spanning 2026-08-15 to 2026-10-05 — three code-facing sections (Files and Code, Key Technical Concepts, Errors and Fixes) consumed about **55%** of every summary while **Next Step took 2%**. The three least reconstructable kinds of content — the reasoning behind a decision, whether a claim was verified, and what is owed — all crowded into the vague `Critical Context` catch-all: 16% of the budget, yet the highest share in every one of those categories (verification 70%, obligations 67%, decision reasoning 46%). Separately, **41%** of summaries never mentioned who was waiting on the Member at all.

**Whether to use it is the host's call**

Nothing here changes existing behavior: the new exports are purely additive. Summaries are written by the engine a host mounts, and the seam is that engine class's `summarize()` hook, so a host may keep the stock template or read this default. Mounting and reading are assembly-time choices this package cannot enforce — which is why this ships a default only: it does not change who writes the summary, and it does not touch trigger mechanics.

**Compatibility**

Two new exports. No new parameters, no peer change, no behavior change. At 0.x this is a minor bump to `0.3.0`.

**Verification**

Local: typecheck clean, `check:boundaries` passes, build emits `compaction-template.js`, and tests are **300/300 green** across 9 files. The new `compaction-template.spec.ts` adds 5 cases pinning that every declared section is actually asked for, in order, and that the two named requirements above are present — a later trim that drops them turns the spec red.
