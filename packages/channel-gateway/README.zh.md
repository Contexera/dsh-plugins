# dsh-channel-gateway

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 channel 网关插件：
适配器把各聊天平台的消息归一成同一套消息契约，网关完成鉴权并分发一个 `channel/inbound`
事件，消费方用入站消息携带的 route 通过 `ctx.channels.send` 回复。

本包覆盖聊天接入的传输层：它固定消息契约，以及 provider 与消费方之间的接缝。
一条消息意味着什么、是否见过、下一步去哪，都由上层决定。

## 契约

五个面就是公开 API，保持小、稳、可版本化。逐字段含义见 [`docs/architecture.md`](docs/architecture.md)。

| 面 | 形状 |
| --- | --- |
| 入站 | `InboundMessage { channel, providerMessageId, actor, place, visibility, text, attachments?, timestamp, replyTo?, raw? }` |
| 出站 | `OutboundMessage { channel, route, text, attachments?, replyTo?, format? }` |
| 传输 | `Channel { name, capabilities, start(inbox), stop(), send(message), resolveAttachment? }` |
| 网关 | `ctx.channels.register(channel)` · `ctx.channels.send(message)` · `ctx.channels.resolveAttachment(channel, attachment)` · 事件 `channel/inbound` |
| 鉴权 | `ChannelAuth { authorize(request) }`，默认 allowlist |

契约中有三处是消费方需要、而 provider 给不出可用形态的：

- **`actor` / `place` / `visibility`** —— 谁说的、在哪、当着谁。
- **`providerMessageId`** —— provider 的稳定 id，供消费方去重与持久接受。
- **`place.route`** —— 由 channel 构造的 **opaque** 目的地：消费方存下见过的 route、
  作为 `OutboundMessage.route` 原样交回；适配器之上没有任何一层拼 provider 地址。

## 安装

本包是一个 DSH bundle，安装即插入 gateway service 行：

```sh
dsh plugin add @wowyuarm/dsh-channel-gateway --profile <profile>
```

适配器是**可选行**（各自需要凭据），由 profile 自己加：

```yaml
- insert:
    - id: channel-telegram
      name: '@wowyuarm/dsh-channel-gateway/telegram'
      config: { token: '<bot token>' }
    - id: channel-weixin
      name: '@wowyuarm/dsh-channel-gateway/weixin'
      config: { token: '<iLink bot token>' }
```

「谁可以说话」是 gateway 那一行的配置，不是适配器的：

```yaml
- id: channel-gateway
  config:
    allow:
      - telegram:123456789   # 某 channel 的某个 actor
      - weixin:*             # 某 channel 的所有 actor
      # - '*'                # 所有人
```

`allow` 为空即谁都不放行。

## 消费

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@wowyuarm/dsh-channel-gateway'

export const name = 'my-ingress'
export const inject = ['channels']

export function apply(ctx: Context) {
  ctx.on('channel/inbound', (message) => {
    // 按 (message.channel, message.providerMessageId) 去重、持久接受、路由。
    void handle(message)
  })
}
```

## 适配器

| 适配器 | 传输 | 入口 | 说明 |
| --- | --- | --- | --- |
| Telegram | Bot API 长轮询（`getUpdates`） | `@wowyuarm/dsh-channel-gateway/telegram` | 文本与媒体。附件优先用本地字节（`data`）上传，否则用 provider `ref` 或 URL；`resolveAttachment` 通过下载取回入站附件的字节。`format: 'markdown'` 渲染为 Telegram HTML。`config.token` 缺省回落到 `DSH_TELEGRAM_TOKEN`。 |
| 微信 | iLink 长轮询（`ilink/bot/getupdates`） | `@wowyuarm/dsh-channel-gateway/weixin` | 文本与媒体。回复要带上入站消息的 `context_token`，微信侧约两分钟后过期，发送前会刷新已过期的 token。`format: 'markdown'` 渲染为清洗后的微信 Markdown。媒体的上传/下载按 iLink 参考协议实现，**尚未在真实账号上验证**。需要一个已获得的 token——扫码登录流程尚未实现。 |

两个适配器都尊重 `HTTPS_PROXY`/`NO_PROXY`（Node 自带 fetch 默认不读这两个变量）。

## 兼容性

DSH 的版本变化只可能经由本包 import 的两个已发布包传导到此处：`@deepseek-ai/cordis`
（插件与 service API）和 `@deepseek-ai/schemastery`（行配置）。本包不 import 任何
`@deepseek-ai/dsh-*` 包——一旦出现，`npm run check:boundaries` 直接让构建失败——
所以宿主耦合就是这两个版本。

| 运行时 | cordis | schemastery | 验证方式 |
| --- | --- | --- | --- |
| DSH `0.1.5-rc.3`（npm `latest`） | `4.0.2` | `3.18.2` | `0.1.0` 发布时：`npm run typecheck`、`npm test`、`npm run build` |
| DSH `0.1.7-rc.1` · `0.1.7-rc.2`（npm `next`） | `4.0.4` | `3.18.4` | 同上三项，外加在真实 profile 里装载该行 |
| 声明的 peer 下界 | `4.0.1` | `3.18.1` | 同上三项 |

devDependencies 钉住第二行，所以检出后的 typecheck／测试／构建跑的就是当前 DSH 实际装载的版本。
peer 区间保持 `^4.0.1` / `^3.18.1`：下界容纳旧 DSH 线，上界容纳当前线，两者有交集，
因此同一个已发布版本对两条线都能安装，而不会在 profile 里解析出第二份 cordis。

针对正在运行的 DSH 复验：

```sh
npm run build
cat > /tmp/channel-gateway.yml <<'EOF'
- insert:
    - id: channel-gateway
      name: 'file:///absolute/path/to/dsh-channel-gateway/lib/index.js'
EOF
dsh --profile <profile> --patch /tmp/channel-gateway.yml --help
```

装载失败的行会在 stderr 报 `N entry did not activate` 并给出原因；干净运行不会打印这一行。
若要断言 service 接缝而不只是 import，可在 overlay 里再加一行声明 `inject: ['channels']`
并从中读取 `ctx.channels.send`。

## 开发

```sh
npm install
npm run typecheck     # tsc，strict
npm test              # 边界守卫 + vitest
npm run build         # 产出 lib/
```

`src/` 只允许 import 自己的相对模块、Node 内置模块，以及 `@deepseek-ai/cordis` / `@deepseek-ai/schemastery`；
适配器可额外使用 `undici`。`npm run check:boundaries` 强制这条线，避免中立层悄悄长出宿主依赖。

## 许可

MIT。Telegram 传输改编自 [`dsh-telegram-channel`](https://github.com/hi-wenw/dsh-telegram-channel)（MIT）；
微信协议形状参考 [`openclaw-weixin`](https://github.com/tencent-weixin/openclaw-weixin)（MIT）与
[`nanobot`](https://github.com/HKUDS/nanobot)（MIT）。
