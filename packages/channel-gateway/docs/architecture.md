# Architecture

`dsh-channel-gateway` is one seam: a transport normalizes what it received, the
gateway authorizes and announces it, and a consumer decides what it means. This
document is the contract reference — what each field means, what the gateway
guarantees, and where the boundary sits.

## Scope

1. **Normalize.** Every adapter turns its provider's payload into one
   `InboundMessage` shape, and one `OutboundMessage` shape back.
2. **Dispatch.** An authorized inbound message is announced once, as the typed
   event `channel/inbound`, and handed to the registered inbound sink when there
   is one.
3. **Authorize.** A pluggable policy answers "may this actor speak here?" before
   anything is announced or accepted.

Deduplication, actor identity beyond the provider's id, session routing, reply
policy and visibility rules are implemented by a consumer. The contract carries
the provider's message id and an opaque route so that a consumer can implement
them without the gateway having to.

## Delivery semantics

Three words, used precisely:

- **Announced** — the gateway broadcast the message as `channel/inbound`. It is
  synchronous, so listener promises are never awaited. This is all a gateway
  with no sink promises.
- **Accepted** — the registered {@link ChannelInboundSink} resolved
  `accept(message)`, meaning a consumer has persisted or durably enqueued it.
- **Delivered** — the adapter's `inbox.deliver(message)` promise settled. It
  settles after authorization, after acceptance when a sink is registered, and
  after the announcement.

Without a sink the gateway offers **best-effort notification**: a message can be
announced and then lost if the process stops before a consumer has stored it. The
gateway does not promise exactly-once, does not promise durable acceptance, and
does not promise a message is not handed over twice. A consumer that needs those
registers a sink through `ctx.channels.registerInboundSink(sink)`:

```ts
const stop = ctx.channels.registerInboundSink({
  async accept(message) { await store.append(message) },
})
```

One sink at a time — acceptance is a durable commitment, and a second consumer
would make "was this accepted" ambiguous; registering another throws
`ChannelGatewayError`. Rules:

1. At most one sink; the returned function unregisters it.
2. The gateway checks channel ownership, then authorizes. A message that fails
   either is dropped: `deliver` **resolves**, because refusing a message is a
   decision about it and re-reading it would only be refused again.
3. With a sink, the gateway awaits `accept` and announces only after it
   resolved — a listener never sees a message that is not durable yet.
4. When the sink rejects, `deliver` rejects too. The adapter then leaves its
   provider cursor or offset where it was, so the provider hands the message over
   again. A rejection is a transient failure to accept; a refusal is not.
5. The sink owns `(channel, providerMessageId)` deduplication. The gateway keeps
   no business dedupe state, so **a sink must be idempotent**: when one message on
   a page fails, an adapter may hand the whole page over again.

Both adapters follow the same rule: a page's deliveries settle before the cursor
moves. For Telegram that is the `getUpdates` offset; for weixin it is the
`get_updates_buf` cursor. The cursor stays inside the adapter and never enters
the gateway's public contract.

## The message contract

### `InboundMessage`

| Field | Meaning |
| --- | --- |
| `channel` | The registered adapter's name (`telegram`, `weixin`). The gateway checks that a channel reports only under its own name. |
| `providerMessageId` | The provider's stable id for this message. A consumer keys deduplication on `(channel, providerMessageId)`. |
| `actor` | Who spoke: `{ id, displayName?, isBot? }`. `id` is the only identity any policy compares; `displayName` is never an identity. |
| `place` | Where: `{ route, kind, title? }`. |
| `visibility` | `private` (only the actor) or `group` (others in the place can see it). |
| `text` | The message text, or `''` when the provider carried none. |
| `attachments` | Zero or more `ChannelAttachment`, as far as the transport could describe them. Their content is fetched on demand through `resolveAttachment`, never eagerly. |
| `timestamp` | ISO 8601 UTC, from the provider's own timestamp. |
| `replyTo` | The provider message id this message answers, when it answers one. |
| `raw` | The provider payload the adapter normalized, untouched, for consumers that need more than the contract carries. |

### `ChannelPlace.route`

The route is the only destination an outbound send accepts. The adapter mints
it, and the gateway never parses it — so an address scheme stays the adapter's
private business, and a provider whose reply needs more than an address (WeChat
needs a short-lived `context_token`) can carry that inside the route instead of
growing the contract a field.

A consumer stores the route it saw and hands it back verbatim. Composing one
from parts is unsupported: no layer above the adapter knows the scheme.

### `OutboundMessage`

`{ channel, route, text, attachments?, replyTo?, format? }`. The gateway resolves
`channel` to a registered adapter and hands the message over; a route the
adapter never minted is the adapter's rejection to raise, because only it knows
its own scheme.

`format` chooses how the channel renders `text`: `markdown` becomes that
provider's own formatted dialect (Telegram HTML, sanitized WeChat Markdown), and
omitted (`plain`) sends the text verbatim, so a consumer that has not opted in
sees no transformation. An outbound `ChannelAttachment` may carry `data` (raw
bytes) for the channel to upload, instead of a provider `url` or `ref`.

### `ResolvedAttachment`

`{ bytes, mimeType?, name? }` — the content behind an inbound attachment, once a
channel has fetched and (where the provider encrypts them) decrypted it. Bytes
rather than a URL or a path: a provider URL may embed the bot's own credential,
and where the bytes live afterwards is the caller's decision.

### `Channel`

| Member | Contract |
| --- | --- |
| `name` | Unique within a gateway; also the `channel` field of every message it reports. |
| `capabilities` | `{ attachments, attachmentDownload, buttons, edit, replyTo, maxTextLength }` — what a consumer may ask for, so it need not guess. |
| `start(inbox)` | Begin receiving; resolving means receiving has started, not finished. A rejection is a failed start: the gateway unregisters the channel and reports it. |
| `stop()` | Stop receiving and release resources; safe after a failed start and after a first stop. |
| `send(message)` | Send one message; returns the provider's id for what it created. An attachment uploads from `data`, else references a provider `url`/`ref`. |
| `resolveAttachment(attachment)` | Present when `capabilities.attachmentDownload`; returns the `ResolvedAttachment` behind one inbound attachment. The gateway exposes the same call as `ctx.channels.resolveAttachment(channel, attachment)`, routing to the channel that reported it. |

## Lifecycle

```ts
ctx.effect(() => {
  const unregister = ctx.channels.register(channel)
  return () => { unregister() }
}, 'channel-gateway.telegram')
```

`register` starts the channel and returns the disposer that stops it. Tying
registration to `ctx.effect` makes the channel's life the adapter plugin's life:
unloading the adapter row unregisters and stops its channel, with no manual
bookkeeping.

A start failure unregisters the channel, so a channel that cannot receive is
never left addressable for sends.

## Authorization

```ts
export interface ChannelAuth {
  authorize(request: ChannelAuthRequest): boolean | Promise<boolean>
}
```

The request carries `{ channel, actor, place, visibility }` — everything a
policy may decide on, and no message body. The gateway asks before announcing,
and a message that is refused (or whose policy throws) is dropped where the
gateway can still log why. The channel is not consulted and does not see the
decision.

The default policy is `allowlistAuth(entries)`: exact `channel:actorId` entries,
`channel:*` for one channel's every actor, `*` for everyone. Both wildcards are
written out explicitly, and an empty list admits nobody.

## Events

`channel/inbound(message)` is declared on Cordis's `Events` interface, so
`ctx.emit` and `ctx.on` are fully typed. It is synchronous broadcast: listener
return values and promises are not awaited.

That makes it a **notification contract, not a delivery guarantee** — this event
tells a listener that a message was authorized, not that anyone stored it. A
consumer that needs durable acceptance registers an inbound sink instead; see
[Delivery semantics](#delivery-semantics).

## Errors

- `ChannelGatewayError` — the caller's mistake: an unknown or duplicate channel,
  a route the named channel never minted, a send carrying neither text nor
  attachments, an adapter asked to send something it cannot.
- A transport failure is anything else the adapter raises; the gateway logs it
  where it owns the call (start, stop) and otherwise lets it reach the caller.
  A send that delivered part of a message before failing is one of these: the
  text is already in the chat and cannot be taken back, so the error names the
  part that arrived and the caller resends only the rest. Resending the whole
  message would duplicate what the recipient can already see.

## Transport

Adapters reach their provider through `proxyAwareFetch()`, which honours
`HTTPS_PROXY`/`HTTP_PROXY` and `NO_PROXY`. It is deliberately always the
package's own `undici` fetch, even when no proxy is set, and it exports the
`FormData` that pairs with it: a multipart body built from a different undici
build than the fetch is not recognized as multipart, and is sent as the literal
string `[object FormData]` instead. The provider then rejects the upload as
empty, which is why adapters must construct multipart bodies from the exported
`FormData` rather than the global one.

## Adapter mappings

### Telegram

| Contract | Bot API |
| --- | --- |
| `providerMessageId` | `message_id` |
| `actor.id` / `displayName` / `isBot` | `from.id` / `first_name` + `last_name` / `from.is_bot` |
| `place.route` | `chat:<chat id>` |
| `place.kind` | `private` → `direct`, `channel` → `channel`, otherwise `group` |
| `place.title` | `chat.title` |
| `visibility` | `direct` → `private`, otherwise `group` |
| `text` | `text`, else `caption` |
| `attachments` | largest `photo`, `document`, `audio`/`voice`, `video` as `ref` = `file_id` |
| `replyTo` | `reply_to_message.message_id` |
| `timestamp` | `date` (seconds) |

Updates with no message, and messages with no sender (channel posts), are
skipped — but the poll offset still advances past them, so one unusable update
cannot block the stream behind it. A silently wedged long poll is aborted by a
client-side watchdog and restarted. Sends split text at 4096 characters, breaking
at the last line break in range, else the last space, else the limit — never
between the two halves of a surrogate pair, and the chunks join back to the
original text; a transient send failure is retried with backoff, honouring the
API's `retry_after`. An attachment sends from local `data` as a multipart
upload, else by its provider `ref` or `url`; `resolveAttachment` reads an inbound
attachment's bytes through `getFile` and a file download. A send delivers text
before attachments, so an attachment that fails after the text went out raises
the partial-delivery error above rather than a bare transport failure.

### Weixin

| Contract | iLink |
| --- | --- |
| `providerMessageId` | `message_id`, else `seq` |
| `actor.id` | `from_user_id` |
| `place.route` | `wx:<base64url from_user_id>.<base64url context_token>` |
| `place.kind` | `group_id` present → `group`, otherwise `direct` |
| `visibility` | as `place.kind` |
| `text` | `text_item.text` values, or a voice item's transcript |
| `attachments` | `image_item`/`voice_item`/`file_item`/`video_item`; the download locator and key are packed into a signed `ref`, so `resolveAttachment` can fetch and AES-128-ECB-decrypt the bytes |
| `timestamp` | `create_time_ms` |

A message whose `message_type` is `2` is this bot's own send coming back, and is
not inbound. `errcode -14` means the token is stale: polling stops rather than
retrying forever. Before a send, a context token past its trusted window is
refreshed through `getconfig`. Outbound media is uploaded to the iLink CDN
(AES-128-ECB, per `getuploadurl`) and sent as a media item; a transient send
failure is retried with backoff.

### Attachment refs

`ref` is the one attachment field a caller can compose, and
`resolveAttachment` is the one call that turns a ref into a network request, so
the ref is authenticated rather than merely parsed. It is
`base64url({ v, d, m })`: a version, the descriptor (`k` kind, `u` full url,
`e` encrypt_query_param, `a` media aes key, `h` item aes key, `n` file name),
and an HMAC-SHA256 over the descriptor's canonical JSON.

`resolveAttachment` verifies the version, the field bounds, the MAC and the
caller-supplied `kind` before it fetches anything, and a ref that fails any of
them raises `ChannelGatewayError` with no request made. A verified locator must
then be `https:` and its host must be one of `attachmentHosts` (default: the
configured CDN host plus the iLink CDN); the download carries an `AbortSignal`
and stops at `maxAttachmentBytes`. The download does not follow redirects: those
two rules are checked against the URL the ref names, so following a `3xx` would
apply them to the first hop only and let an allowlisted host hand the transfer to
an address that was never checked. The MAC key derives from the bot token, so a
token rotation invalidates refs minted under the old one; `attachmentRefSecret`
pins a stable key when refs must outlive a rotation. A descriptor that cannot be
represented within the field bounds is reported as an attachment with no `ref`,
because provider fields arrive unbounded and a hostile payload must not fail the
message it arrived in. The same degradation covers a descriptor that passes every
per-field bound but encodes to a ref longer than `WEIXIN_REF_MAX_LENGTH`: the
per-field ceilings count UTF-16 code units while the ref is base64url over UTF-8
bytes, so minting checks the encoded length against the ceiling the opener
enforces. A ref this channel hands out is therefore always one it can open.

## Host compatibility

The package's host coupling is two versions: `@deepseek-ai/cordis` for the plugin
and service API, and `@deepseek-ai/schemastery` for row config. Both are peers,
and `scripts/check-boundaries.mjs` rejects every other non-relative, non-builtin
import, so a DSH release reaches this package only by changing one of those two.

The peers are declared `^4.0.1` / `^3.18.1` while the devDependencies pin
`4.0.4` / `3.18.4` — the pair DSH `0.1.7-rc.1` and `0.1.7-rc.2` ship. The floor
still admits the older `latest` line (`0.1.5-rc.3` ships `4.0.2` / `3.18.2`),
the ceiling admits the current one, and the two ranges overlap, so one published
version pairs with either without resolving a second copy of cordis into the
profile.

DSH's own compatibility preflight reads `@deepseek-ai/dsh` and
`@deepseek-ai/dsh-*` peers; this package declares none, so the mount check in the
README is the host-side guard, run by hand when a DSH line advances.

## Known gaps

- **Weixin has no login flow.** It starts from a token it is given; the iLink QR
  login, credential persistence and re-login are not implemented.
- **Weixin media is reverse-engineered.** Download (AES decrypt) and upload
  (CDN) follow the reference iLink client via `nanobot`, not official docs, and
  are not yet verified against a live account.
- **A reply after ~2 minutes may still fail on WeChat.** The adapter refreshes a
  stale context token before sending, but a token that is long dead cannot be
  refreshed; a consumer that must answer much later needs a fresh inbound
  message. That expiry is the provider's rule, not a policy this layer applies.
- **No webhook transport.** Both adapters poll. A webhook channel would need an
  injected HTTP server; the `Channel` interface already accommodates one (`start`
  receives a host object), but nothing consumes `ctx.webServer` yet.
