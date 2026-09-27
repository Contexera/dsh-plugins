# dsh-channel-gateway

A channel gateway plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
A channel adapter normalizes provider traffic into one message contract, the
gateway authorizes it and announces a single `channel/inbound` event, and a
consumer answers through `ctx.channels.send` with the route the inbound message
carried.

The package covers the transport half of a chat integration: it fixes the
message contract and the seam between a provider and a consumer. What a message
means, whether it was seen before, and where it goes next are decided above it.

## Contract

Five surfaces, and they are the public API — keep them small, stable and
versionable. Field-by-field reference in [`docs/architecture.md`](docs/architecture.md).

| Surface | Shape |
| --- | --- |
| Inbound | `InboundMessage { channel, providerMessageId, actor, place, visibility, text, attachments?, timestamp, replyTo?, raw? }` |
| Outbound | `OutboundMessage { channel, route, text, attachments?, replyTo?, format? }` |
| A transport | `Channel { name, capabilities, start(inbox), stop(), send(message), resolveAttachment? }` |
| The gateway | `ctx.channels.register(channel)` · `ctx.channels.send(message)` · `ctx.channels.resolveAttachment(channel, attachment)` · event `channel/inbound` |
| Authorization | `ChannelAuth { authorize(request) }`, defaulting to an allowlist |

Three parts of the contract exist because a consumer needs them and a provider
does not supply them in a usable form:

- **`actor` / `place` / `visibility`** — who spoke, where, and in front of whom.
- **`providerMessageId`** — the provider's stable id, so a consumer can
  deduplicate and accept durably.
- **`place.route`** — an opaque, channel-minted destination. A consumer stores
  the route it saw and hands it back as `OutboundMessage.route`; no layer above
  the adapter composes a provider address.

## Install

The package is a DSH bundle: adding it inserts the gateway service row.

```sh
dsh plugin add @wowyuarm/dsh-channel-gateway --profile <profile>
```

Channel adapters are opt-in rows, because each needs its own credentials. A
profile adds the ones it wants:

```yaml
- insert:
    - id: channel-telegram
      name: '@wowyuarm/dsh-channel-gateway/telegram'
      config: { token: '<bot token>' }
    - id: channel-weixin
      name: '@wowyuarm/dsh-channel-gateway/weixin'
      config: { token: '<iLink bot token>' }
```

Who may speak is the gateway row's own configuration, not the adapter's:

```yaml
- id: channel-gateway
  config:
    allow:
      - telegram:123456789   # one actor of one channel
      - weixin:*             # every actor of one channel
      # - '*'                # everyone
```

An empty `allow` list admits nobody.

## Consuming it

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@wowyuarm/dsh-channel-gateway'

export const name = 'my-ingress'
export const inject = ['channels']

export function apply(ctx: Context) {
  ctx.on('channel/inbound', (message) => {
    // Deduplicate on (message.channel, message.providerMessageId), accept it
    // durably, route it.
    void handle(message)
  })
}

async function handle(message: InboundMessage) {
  // ... later, answer it:
  await ctx.channels.send({ channel: message.channel, route: message.place.route, text: 'ok' })
}
```

## Adapters

| Adapter | Transport | Entry | Notes |
| --- | --- | --- | --- |
| Telegram | Bot API long poll (`getUpdates`) | `@wowyuarm/dsh-channel-gateway/telegram` | Text and media. An attachment sends from local bytes (`data`), else a provider `ref` or `url`; `resolveAttachment` reads an inbound attachment's bytes by download. `format: 'markdown'` renders as Telegram HTML. `DSH_TELEGRAM_TOKEN` is the fallback for `config.token`. |
| Weixin | WeChat iLink long poll (`ilink/bot/getupdates`) | `@wowyuarm/dsh-channel-gateway/weixin` | Text and media. A reply quotes the inbound `context_token`, which WeChat expires after roughly two minutes; the adapter refreshes a stale one before sending. `format: 'markdown'` renders as sanitized WeChat Markdown. The media download/upload path follows the reference iLink protocol and is **not yet verified against a live account**. Starts from a token it is given — the QR login flow is not implemented yet. |

Both adapters honour `HTTPS_PROXY`/`NO_PROXY` (Node's own fetch does not, unless
`NODE_USE_ENV_PROXY` is set).

## Compatibility

A DSH release can reach this package only through the two published packages it
imports: `@deepseek-ai/cordis` (the plugin and service API) and
`@deepseek-ai/schemastery` (row config). No `@deepseek-ai/dsh-*` package is
imported — `npm run check:boundaries` fails the build if one appears — so the
host coupling is exactly those two versions.

| Runtime | cordis | schemastery | Verified by |
| --- | --- | --- | --- |
| DSH `0.1.5-rc.3` (npm `latest`) | `4.0.2` | `3.18.2` | the `0.1.0` release: `npm run typecheck`, `npm test`, `npm run build` |
| DSH `0.1.7-rc.1` · `0.1.7-rc.2` (npm `next`) | `4.0.4` | `3.18.4` | the same three checks, plus a real row mount in a booted profile |
| Declared peer floor | `4.0.1` | `3.18.1` | the same three checks |

The devDependencies pin the second row, so a checkout typechecks, tests and
builds against what the current DSH ships. The declared peers stay at
`^4.0.1` / `^3.18.1`: the floor admits the older DSH line, the ceiling admits
the current one, and the two ranges overlap, so one published version installs
against either without a second copy of cordis in the profile.

Re-verify against a running DSH:

```sh
npm run build
cat > /tmp/channel-gateway.yml <<'EOF'
- insert:
    - id: channel-gateway
      name: 'file:///absolute/path/to/dsh-channel-gateway/lib/index.js'
EOF
dsh --profile <profile> --patch /tmp/channel-gateway.yml --help
```

A row that fails to import is reported on stderr as `N entry did not activate`
with its reason; a clean run prints no such line. To assert the service seam
rather than the import alone, add a second row to the overlay that declares
`inject: ['channels']` and reads `ctx.channels.send` from it.

## Development

```sh
npm install
npm run typecheck     # tsc, strict
npm test              # boundary guard + vitest
npm run build         # emits lib/
```

`src/` may import only its own relative modules, Node builtins, and
`@deepseek-ai/cordis` / `@deepseek-ai/schemastery`; adapters may add `undici`.
`npm run check:boundaries` enforces exactly that, so the neutral seam cannot
quietly acquire a host dependency.

## License

MIT. The Telegram transport is adapted from
[`dsh-telegram-channel`](https://github.com/hi-wenw/dsh-telegram-channel) (MIT);
the WeChat protocol shape follows
[`openclaw-weixin`](https://github.com/tencent-weixin/openclaw-weixin) (MIT) and
[`nanobot`](https://github.com/HKUDS/nanobot) (MIT).
