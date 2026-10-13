---
'@contexera/dsh-channel-gateway': minor
---

Add a reliable inbound acceptance seam, and tie provider cursors to it.

`channel/inbound` is a synchronous broadcast, so it could only ever promise that
an authorized message was *announced* — not that a consumer stored it, and not
that the provider would not hand it over again. An adapter had no answer it could
await before advancing its provider cursor, so a message that a consumer failed to
persist was already behind the cursor and could not be re-fetched.

`ChannelInboundSink` is that seam: `accept(message)` returns a promise that
settles only once the message is durably accepted. Register at most one through
`ctx.channels.registerInboundSink(sink)`; registering a second throws
`ChannelGatewayError`. With a sink registered the gateway awaits `accept` before
announcing `channel/inbound`, and a rejection propagates to the delivering
adapter, which then leaves its cursor alone so the provider hands the message over
again. A message refused by ownership or authorization still resolves, because
re-reading it would only be refused again.

`ChannelInbox.deliver` now returns `Promise<void>` instead of `void`, and both
adapters await a page's deliveries before advancing the Telegram `getUpdates`
offset or the weixin `get_updates_buf` cursor. A partially failed page is handed
over again, so a sink must be idempotent and owns
`(channel, providerMessageId)` deduplication — the gateway keeps no dedupe state.

Without a sink, behavior is unchanged: the event remains best-effort
notification. The docs now use `announced`, `accepted` and `delivered` for the
three distinct states, and no longer imply durable acceptance or exactly-once.
