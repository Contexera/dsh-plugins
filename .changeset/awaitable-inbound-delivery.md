---
'@contexera/dsh-channel-gateway': minor
---

Add a reliable inbound acceptance seam.

`channel/inbound` is a synchronous broadcast, so it could only ever promise that
an authorized message was *announced* — not that a consumer stored it, and not
that the provider would not hand it over again. An adapter had no answer it could
await, so a message a consumer failed to persist could not be re-fetched.

`ChannelInboundSink` is that seam: `accept(message)` returns a promise that
settles only once the message is durably accepted. Register at most one through
`ctx.channels.registerInboundSink(sink)`; registering a second throws
`ChannelGatewayError`. With a sink registered the gateway awaits `accept` before
announcing `channel/inbound`, and a rejection propagates to the delivering
adapter. A message refused by ownership or authorization still resolves, because
re-reading it would only be refused again.

`ChannelInbox.deliver` now returns `Promise<void>` instead of `void`. Without a
sink, behavior is unchanged: the event remains best-effort notification, which the
docs now say plainly and distinguish from `accepted`.
