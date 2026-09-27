# dsh-context-continuity —— 跨多个 Session 的一段连续 context

[English](README.md) | [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/@wowyuarm/dsh-context-continuity?style=flat-square)](https://www.npmjs.com/package/@wowyuarm/dsh-context-continuity)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里的 agent
自己管理 context，把过去的 Session 变成能随时调用的 context。**

## 要解决的问题

每个 Session 迟早会写满。它会被压缩，或者 rollover 成一个新的——然后 agent 就断片了。
它手头在做的事、刚想明白的东西，一下子被挡在了墙的另一边。

这个插件给 agent 几件工具，让它自己翻过这堵墙：Session 快满时，它写一段简短的交接，然后在
新 Session 里作为同一个 agent 接着干；它可以标记一个位置方便以后回来；挂上可选的检索工具
之后，它还能回头搜自己早先的 Session，把当时说过、做过的事翻出来。任何跑得够久、会把
Session 写满的 agent 都能用——
[Loom](https://github.com/wowyuarm/Loom) 的 individual、[Agent Team](https://github.com/wowyuarm/dsh-agent-team)
的 member、跑长任务的 coding agent。

## agent 能用到什么

三个它能调用的工具，外加一层自动兜底——这些开箱即用，所以每个接入本插件的插件，都给自己
的 agent 提供同一套：

- **`context_rollover`** —— 开一个新 Session，但还是同一个 agent，把你写的交接带进新 Session。
- **`context_checkpoint`** —— 标记当前位置，方便以后回到这里。
- **`context_timeline`** —— 回看自己的历史，挑一个能安全返回的位置。
- **压力兜底** —— Session 快满时提前提醒，到上限时给一个安全退路，agent 不会被迫在糟糕的
  时机切换。

另外两个是**可选的**——只有你自己挂载 `createSearchTools`，agent 才会拿到：

- **`context_search`** —— 在自己早先的 Session 里搜某件说过或做过的事。
- **`context_read`** —— 打开一条搜索结果，读它周围的上下文。

它们单独分开，是因为对你的接入要求比核心那几个更高：你要提供一个 `session-query` port
——也就是它们据以定型的已发布 `@deepseek-ai/dsh-session-query` 契约，本包为它声明了 peer
——还要给出每个主体可以搜哪些历史 Session。部署侧也得配合：这条检索阶梯读的是 Harness 的
Session 索引，所以把索引关着的部署只会 fail closed，而不是返回结果。接线见
[`docs/integration.md`](docs/integration.md) 的 seam 7。

## 它怎么工作

Harness 本身已经会 fork Session、从旧 Session 开一个新的、把 Session 日志当作唯一事实来源。
这个插件不重造这些，而是在上面补一件 Harness 没做的事：把一串 Session 串成同一个 agent
在时间里的延续。切换本身、安全检查、判断哪些历史位置能安全返回这些麻烦事它自己扛，只向你的
插件要它自己没法知道的那点信息。背后的理由见 [`docs/principles.md`](docs/principles.md)。

## 在你的插件里用它

你告诉它你的 agent 是谁、以及在你自己的环境里怎么执行一次 Session 切换——如果你还挂了检索
工具，再告诉它允许搜哪些历史 Session，剩下的它来做。带代码的分步接入指南见
[`docs/integration.md`](docs/integration.md)。

## 开发

```bash
npm install
npm test          # 包边界检查 + 单元测试
npm run typecheck # 严格 TypeScript，不产出
npm run build     # 产出 lib/
```

测试跑在发布的 `@deepseek-ai/dsh-*` 包上——不需要 sibling harness checkout，整套测试一秒内跑完。
