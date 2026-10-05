---
"@wowyuarm/dsh-context-continuity": minor
---

[中文](#cn-v0-2-2-guidance) | [English](#en-v0-2-2-guidance)

<h3 id="cn-v0-2-2-guidance">中文</h3>

四个工具的描述里，有三处在对所有宿主讲错或讲空的话——这一版改的是**判断**，不是措辞口味。

**`context_checkpoint`：触发条件从"接下来危险吗"改成"这个 context 我以后会想回来吗"**

旧默认值只说了"进 noisy/risky 之前"。但记一个 checkpoint 很便宜（一次调用，下一轮自动继续），它买的是一个**选项**而不是一次承诺；真正该问的是"现在这个 context 是不是我可能想回来的那一个"。于是覆盖范围扩到整族情形：一场以结论而非过程为价值的深挖、一个可能放弃的改动、刚谈定某事之后、离开主线办长支线之前、以及一段预计会把窗口塞满的过程（长文件、大工具输出、构建循环）。风险型的重构只是其中一例。旧措辞把这一族收窄成"风险"，正是这个动作没被用起来的原因。

**`context_rollover`：补上"带 checkpointRef 回返到底做了什么"**

旧描述只讲了**怎么安全引用** ref，从没讲**它是干什么的**——而这件事从参数里读不出来：新代站在锚点前缀上**逐字**打开，**并且 handoff 照样写、照样投递**。所以这个动作是"自挑的无损基底 + 自写增量"，不是丢弃。描述现在说明了形状、说明了它适用的情况（值钱的部分在某段**之前**、那段之后只剩几句话可说），并点明它与 `context_compact` 互为镜像：compaction 保最近、摘要更老；回返保更老、让主体自己概括之后。

**`context_compact`：说明摘要不是你写的**

摘要由引擎的 summarization 生成。主体从参数里同样看不出这一点，而这正是 compact 与回返之间的分水岭：需要某段以**自己的话**活下来的，就不能指望一个不是自己写的摘要。描述现在这么说，并指向回返。

**`jobsNote`：把一条宿主承诺从引擎描述里摘出来**

旧描述承诺"a rollover is refused while jobs this agent owns are still running"。引擎**没有 job 概念**，永远不会因此拒绝——这条保证只有宿主能兑现（Agent Team 有 owner job，对它成立）。新的 `jobsNote` 旋钮默认保持原句，宿主可以传 `''` 丢掉它，而不是让模型读到一条不可能发生的拒绝。

**顺带一句"什么都不删"**

旧 rollover 描述没有对应句（compact 有"The log is append-only"），于是"结束一代"读起来像销毁历史。现在明说：结束的一代被归档、compaction 替换的是你看到的东西而不是被记录的东西——你选的是**什么留在眼前**，不是什么存活。

<h3 id="en-v0-2-2-guidance">English</h3>

Three of the four tool descriptions were telling every host something wrong or nothing at all. This release changes the **judgement** they carry, not the taste of the wording.

**`context_checkpoint`: the trigger is the state being left, not the risk ahead.** The old default asked for one "before a noisy or risky phase". A checkpoint is cheap — one call, and work continues in the next turn — so it buys an *option* rather than committing to a return, and the question worth asking is whether this context is one the subject might want back. The guidance now covers the whole family: a long dig whose value is its conclusion rather than its trail, a change the subject may want to abandon, just after something important got settled, before leaving the main line for a long errand, and before a stretch likely to fill the window with bulk. A risky refactor is one instance. Narrowing that family to risk is what left the move unused.

**`context_rollover`: what a `checkpointRef` return actually does.** The old description said only how to cite a ref safely and never what the move is for — and none of it is readable from the arguments: the new generation opens on the anchor's prefix **word for word**, *and* the handoff is still written and delivered on top of it. The move is a chosen verbatim base plus a self-written delta, not a discard. The description now states that shape, the situation it fits (the value sits *before* a stretch, and the stretch since is worth a few sentences), and that it is the mirror of `context_compact`: compaction keeps the recent tail and summarizes what is older, while a return keeps an older stretch and lets the subject summarize what came after.

**`context_compact`: the summary is not written by the subject.** It is produced by the mounted engine's summarization. That is equally invisible from the arguments, and it is the dividing line between this tool and a return: a passage that has to survive in the subject's own words cannot rely on a summary it did not write. The description now says so and points at the return.

**`jobsNote`: a host promise lifted out of an engine description.** The old text promised "a rollover is refused while jobs this agent owns are still running". The engine has **no job concept** and never refuses over one — only a host can honour that sentence (the Agent Team does, with owner jobs). The new `jobsNote` knob keeps the sentence by default and lets a host pass `''` to drop it, rather than leave the model reading a refusal that cannot happen.

**And one sentence that says nothing is deleted.** The rollover description had no counterpart to compaction's "The log is append-only", so "end this generation" read like destroying history. It now states that an ended generation is archived and that a compaction replaces what the subject sees rather than what was recorded: what is being chosen is what stays in front of it, not what survives.
