---
"@wowyuarm/dsh-context-continuity": minor
---

[中文](#cn-v0-1-7-status) | [English](#en-v0-1-7-status)

<h3 id="cn-v0-1-7-status">中文</h3>

`context_timeline` 改名为 **`context_status`**：它不再只是"回看历史、挑一个返回点"，而是"读我现在站在哪、能做什么、代价多少"。同一个工具改名换描述，不新开一个。

**工具面**

- **描述换了触发方式**：删掉那句把工具锁在"我已经决定要回退"上的门——`Use this tool when you specifically intend a checkpointRef return…`——改成按情形触发：`Call it at a boundary, after a long gap, or when you are unsure where you stand.` 引用 ref 的安全句仍在，只是收成 `cite a checkpointRef only when this status listed that exact ref as restorable`。`context_rollover`、`context_checkpoint` 的描述与拒绝文案里的旧名一并改掉：改名只改一处，模型看到的每一处都指向同一个工具。
- **输出首行给数字**，锚点行一个字没动：

```
Context: 149,763 / 200,000 handoff / 256,000 hard limit
Composition (heuristic): system ~8K · tools ~11K · messages ~131K
Anchors: 8 rows · 5 restorable
- before the extraction [source: checkpoint] (retained ~140000, discarded ~9360; Threads thread:b485f9a3) — restorable — ref: …
Compact now: about 118K compactible; keeps the last ~33K verbatim
```

**契约**

- `ContextTimeline` 加两个**可选**字段，宿主供数、引擎渲染：
  - `composition`：`systemTokens` / `toolsTokens` / `messagesTokens`，启发式估算。注意 **`toolsTokens` 是工具 schema，不是工具结果**——工具结果算在 `messagesTokens` 里。
  - `compactible`：`compactibleTokens` / `retainedTailTokens`，即"现在压一次会替换掉多少、最近这一段有多少原样留下"。
- 新增导出 **`compactibleNow(session, scope)`**：它按 `context_compact` 自己的选区走一遍来定价。宿主不要自己拿"用量 − 保留尾"去减——那样状态面报的数和压缩实际做的事会漂开。
- 两个字段缺席时**不渲染对应行**，更不编造 `0`：没有 meter、或该 scope 没挂压缩引擎，说的是"这个数不知道"，不是"没什么可压"。

**兼容性**

- **工具名变了，这是宿主可见的破坏性改动。** 自己复制过 timeline 工具（例如 Agent Team）的宿主必须跟着改名：引擎自己的 `context_rollover` 描述现在指向 `context_status`，而模型手上那个工具还叫 `context_timeline`——描述与工具名对不上。0.x 下按 minor 计入 `0.1.7`。
- `ContinuityTools.timeline` → `ContinuityTools.status`：注册句柄跟着工具名走。`ContinuityToolAdapter.timeline()` **不变**——它读的仍是 timeline，只是由 `context_status` 渲染。
- 宿主不供新数据时，除首行与新增的锚点计数行外，输出与 `0.1.6` 一致。

**验证**

本地：`check:peers`、typecheck、boundaries、整仓 `-r test` / `-r typecheck` 全绿；本包 251/251（8 个文件，`context_compact` 那版是 241）。三条会变红的测试各做了一次变异验证：渲染丢掉组成行、`compactibleNow` 把"无法定价"当成 0、描述退回旧门句。

<h3 id="en-v0-1-7-status">English</h3>

`context_timeline` is renamed **`context_status`**: it no longer only means "look back and pick somewhere to return to", it means "read where I stand, what I can do, and what it costs". One tool renamed and reworded — not a second tool.

**The tool surface**

- **The description now opens on a situation, not an intention.** The gate that kept the tool invisible until the model had already decided to return — `Use this tool when you specifically intend a checkpointRef return…` — is replaced by `Call it at a boundary, after a long gap, or when you are unsure where you stand.` The ref-discipline sentence stays, tightened to `cite a checkpointRef only when this status listed that exact ref as restorable`. The old name is gone from the `context_rollover` and `context_checkpoint` prose and rejections too: one rename, every reference pointing at the tool the model will actually find.
- **The first lines carry the numbers**; the anchor rows are unchanged:

```
Context: 149,763 / 200,000 handoff / 256,000 hard limit
Composition (heuristic): system ~8K · tools ~11K · messages ~131K
Anchors: 8 rows · 5 restorable
- before the extraction [source: checkpoint] (retained ~140000, discarded ~9360; Threads thread:b485f9a3) — restorable — ref: …
Compact now: about 118K compactible; keeps the last ~33K verbatim
```

**The contract**

- `ContextTimeline` gains two **optional** fields, host-supplied and engine-rendered:
  - `composition`: `systemTokens` / `toolsTokens` / `messagesTokens`, a heuristic split. Note that **`toolsTokens` prices the tool schemas offered to the model** — a tool result is a message and counts in `messagesTokens`.
  - `compactible`: `compactibleTokens` / `retainedTailTokens` — what a compaction started now would replace, and how much of the recent tail stays verbatim.
- New export **`compactibleNow(session, scope)`**: it prices that pair by running the same selection `context_compact` performs. Do not subtract "usage − retained tail" yourself — a status read and the action it announces would drift apart.
- When either field is absent, its **line is not rendered**, and no `0` is invented: no meter, or no compaction engine in that scope, means the number is unknown — not that nothing can be compacted.

**Compatibility**

- **The tool name changed, and that is a host-visible breaking change.** A host that keeps its own copy of the timeline tool (the Agent Team does) must follow the rename: the engine's own `context_rollover` description now points at `context_status`, while the tool the model can actually call is still named `context_timeline` — the prose and the roster disagree. At 0.x this rides `0.1.7` as a minor.
- `ContinuityTools.timeline` → `ContinuityTools.status`: the registration handle follows the tool name. `ContinuityToolAdapter.timeline()` is **unchanged** — it still reads the timeline; `context_status` merely renders it.
- A host that supplies neither new field sees the `0.1.6` output apart from the first line and the new anchor-count line.

**Verification**

Local: `check:peers`, typecheck, boundaries, and repository-wide `-r test` / `-r typecheck` all green; 251/251 tests in this package (8 files; the `context_compact` change left it at 241). Three tests that can go red were mutation-checked: dropping the composition line from the render, pricing "cannot be measured" as `0` in `compactibleNow`, and restoring the old gate sentence in the description.
