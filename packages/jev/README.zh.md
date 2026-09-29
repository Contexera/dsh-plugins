# dsh-jev

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Jev（TypeSafe
System One）Cordis 服务：一次无头判断调用，`ctx.jev.decide(...)`。

这个服务是给「主模型没在跑」的场合用的——回合结束后的主动性判断、维护循环里给局面打分。
也正因如此它是 service 而非 tool：工具形态得先把主模型叫起来问它要不要动，而「要不要动」
正是这里要判断的事。

它自身不含任何策略：不设阈值、不做门控、不定姿态或词表，也不把失败解释成「安静」。
它只把给定的问题发出去，返回 vendor 的答案；没有答案时抛类型化的 `JevError`。

## 契约

| 面 | 形状 |
| --- | --- |
| 服务 | `ctx.jev.decide({ state, questions, signal? }): Promise<JevResult>` |
| 结果 | `JevResult { model, answers, usage }` —— vendor 响应原样返回 |
| 问题 | `noul`（是/否）· `choice`（选项，无序）· `score`（刻度，有序，最多十档） |
| 答案 | `{ type: 'noul', noul }` · `{ type: 'choice', choice, confidence, probabilities }` · `{ type: 'score', score, confidence, legend, probabilities }` |
| 失败 | `JevError`，`kind: 'config' \| 'request' \| 'transport' \| 'timeout' \| 'http' \| 'protocol' \| 'cancelled'` |

`decide` 返回整个响应而不是只返回 `answers`，因为其中两个成员承重：`model` 报出真正应答的
版本化 id，这是「钉版本」唯一可核对之处；`usage` 带着本次调用的成本。答案按 vendor 发来的
样子透传——本包校验的是响应信封，不是每个答案成员。逐字段形状与重试策略见
[`docs/architecture.md`](docs/architecture.md)。

## 安装

本包是 DSH bundle：装上即插入 Jev 服务行。

```sh
dsh plugin add @wowyuarm/dsh-jev --profile <profile>
```

行里配置端点、模型与边界；密钥来自环境变量，配置文件里不留秘密：

```yaml
- id: jev
  config:
    apiKeyEnv: TYPESAFE_API_KEY
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `apiBase` | `https://api.typesafe.ai/v1` | 端点基址；调用发往它加 `/systemone`。 |
| `model` | `jev-1.13.0` | 每次调用携带的模型 id。 |
| `apiKey` | — | 密钥本身。优先用 `apiKeyEnv`。 |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | 存放密钥的环境变量名。 |
| `timeoutMs` | `30000` | 单次尝试的时限。 |
| `attempts` | `3` | 一次调用的尝试次数，含首次。 |
| `retryDelayMs` | `500` | 第二次尝试前的等待；之后每次翻倍。 |
| `maxRetryDelayMs` | `30000` | 两次尝试之间的最长等待。 |

**缺密钥在加载时就失败**，而不是等到第一次调用：无法鉴权的部署应当只说一次，而不是在被消费方
fail-closed 吞掉之后、每个回合都失败一次。

**模型 id 的命名随路线不同。** vendor 自家端点形如 `jev-1.13.0`；OpenRouter 那条路用
`typesafe/jev-1.13`。`apiBase` 可配，所以换了 base 通常也要一起换 `model`。默认值钉版本而非
别名是有意的：阈值是拿某一个模型的答案校准的，`latest` 别名一旦漂移，校准会静默作废。

**密钥不会出现在本包产生的任何消息或日志里**：错误文案与响应摘录都会对它做遮蔽。

## 使用

```ts
import type { Context } from '@deepseek-ai/cordis'
import { JevError } from '@wowyuarm/dsh-jev'

export const name = 'loom-after-chat'
export const inject = ['jev']

export async function judge(ctx: Context, state: string, signal: AbortSignal): Promise<number | undefined> {
  try {
    const result = await ctx.jev.decide({
      state,
      questions: {
        speak: {
          type: 'noul',
          instructions: 'should the assistant say something now?',
          criteria: { true: 'speak up', false: 'stay quiet' },
        },
      },
      signal,
    })
    const answer = result.answers['speak']
    if (answer?.type !== 'noul') return undefined
    return answer.noul // 0..1 —— 阈值由消费方自己判定
  } catch (error: unknown) {
    if (error instanceof JevError) return undefined // fail closed 属于消费方
    throw error
  }
}
```

`signal` 可选，并且是一次调用耗时的唯一硬边界：不该阻塞的消费方——比如插入之前要复核的
回合后流程——可以放弃已经不需要的调用；取消永不重试。

## 失败

| kind | 何时抛出 | 是否重试 |
| --- | --- | --- |
| `config` | 端点、模型、边界或密钥不可用。在插件加载时抛出。 | 否——没有任何调用能成功 |
| `request` | 本次调用不合文档。什么都没发出去。 | 否 |
| `transport` | 网络或 TLS 失败。 | 是 |
| `timeout` | `timeoutMs` 内没有响应。 | 是 |
| `http` | 端点返回非 2xx；状态码在 `status` 上。 | 408、429、5xx |
| `protocol` | 2xx 的 body 不是文档中的响应：JSON 不是那个信封、缺答案、答案类型与提问不符。 | 否 |
| `cancelled` | `signal` 触发，在尝试中或在两次尝试的等待中。 | 否 |

端点给的 `retry-after` 会被遵守，但不超过 `maxRetryDelayMs`：更长的会直接结束调用，而不是
阻塞超过部署配置的边界。每次重试都会带上尝试序号与原因写日志。

## 兼容性

本包只通过两个已发布包接触宿主：cordis（插件与服务 API）与 schemastery（行配置）。它不 import
任何 `@deepseek-ai/dsh-*` 包——一旦出现，`check:boundaries` 会让构建失败——因此不绑定 DSH
版本线，`check:peers` 会把它报成「没有需要认证的 DSH 版本线」。

| 依赖 | 声明的 peer | 钉住并测试的版本 |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `^4.0.1` | `4.0.4` |
| `@deepseek-ai/schemastery` | `^3.18.1` | `3.18.4` |

**线上契约已于 2026-09-29 用真实端点跑通**，走的就是本包构建后的入口。一次调用同时带
`noul`、`choice`、`score` 三个问题，返回 `model: "jev-1.13.0"`、每个 id 一个答案、
`usage` 只有 `input_tokens` 与 `output_tokens`，成员形状与
[`docs/architecture.md`](docs/architecture.md) 记录的一致——包括按档位号 keyed 的 score
`legend`。端点同时接受了 `null` 选项描述、`noul` 的 criteria 对象，以及 criteria 里的结构化
条目；对「把 score 的 criteria 写成对象」返回 `422 Input should be a valid list`；对无效密钥返回
`401`，本包将其报成不重试的 `http` 失败，且绝不把密钥写进消息。

尚未在线上观察到的：任何一次重试（没撞上 `429`、5xx 或超时），以及 vendor 自家端点之外的路线。
这些路径由离线测试通过注入的 transport 覆盖。

对运行中的 DSH 复核：

```sh
corepack pnpm --filter @wowyuarm/dsh-jev build
cat > /tmp/jev.yml <<'EOF'
- insert:
    - id: jev
      name: 'file:///absolute/path/to/dsh-plugins/packages/jev/lib/index.js'
      config: { apiKeyEnv: TYPESAFE_API_KEY }
EOF
dsh --profile <profile> --patch /tmp/jev.yml --help
```

导入失败的行会在 stderr 上报 `N entry did not activate` 并给出原因。要真打一次调用，再加一行声明
`inject: ['jev']`、调用一次 `ctx.jev.decide` 并打印 `result.model`：它会报出真正应答的模型 id，
而这正是钉住 `model` 本身看不出来的那件事。

## 开发

```sh
corepack pnpm install
corepack pnpm --filter @wowyuarm/dsh-jev typecheck   # tsc，strict，不产出
corepack pnpm --filter @wowyuarm/dsh-jev test        # 边界守卫 + vitest，全离线
corepack pnpm --filter @wowyuarm/dsh-jev build       # 产出 lib/
```

`src/` 只允许 import 自己的相对模块、Node 内置模块，以及上面两个声明的 peer；`check:boundaries`
强制执行这一点，因此这个中立接缝不会悄悄长出一个宿主依赖。测试全部驱动注入的 transport，不需要
密钥，也不需要网络。

## License

MIT。
