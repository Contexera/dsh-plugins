---
"@wowyuarm/dsh-context-continuity": patch
---

[中文](#cn-v0-2-1-status-rows) | [English](#en-v0-2-1-status-rows)

<h3 id="cn-v0-2-1-status-rows">中文</h3>

`context_status` 的锚点表把**只差 anchor 摘要**的相邻行合成一行：这一行给出行数、共同的 label / source / kind / 尺寸 / topics / 原因，并列出它覆盖的每一个 anchor 摘要，所以"每一行都点得出名字"这条保证对整段仍然成立。

多 topic 的上下文天然会攒出这种串：每条进入上下文的 Team fact 各留一个边界锚点，而它们的 label、尺寸、topics、原因**完全一样**，逐行重复只增加长度、不增加信息。

**可恢复的行永不合并**：`ref:` 只能出现在可恢复行上，一行一个，合并段在可恢复行处断开。

<h3 id="en-v0-2-1-status-rows">English</h3>

The `context_status` anchor table folds adjacent rows that differ **only by their anchor digest** into one line: that line gives the row count, the shared label / source / kind / sizes / topics / reason, and every anchor digest it covers, so the guarantee that a row can be named still holds for the run as a whole.

A multi-topic context accumulates such runs by nature: every fact that entered it leaves one boundary anchor, and those rows share a label, sizes, topics and reason exactly, so repeating them line by line adds length without information.

**A restorable row is never merged**: the citable `ref:` form appears on restorable rows only, one per row, and a run is cut around every one of them.
