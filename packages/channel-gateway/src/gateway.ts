/**
 * The gateway service: register channels, authorize inbound, announce
 * `channel/inbound`, send outbound.
 *
 * It does not interpret messages: what a message means, where it goes next and
 * whether it was seen before are decided by whoever listens to the event or
 * calls {@link ChannelGateway.send}.
 * @module @contexera/dsh-channel-gateway/gateway
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { allowlistAuth, type ChannelAuth } from './auth.ts'
import type {
  Channel,
  ChannelAttachment,
  ChannelInboundSink,
  ChannelInbox,
  ChannelSendResult,
  InboundMessage,
  OutboundMessage,
  RegisteredChannel,
  ResolvedAttachment,
} from './contracts.ts'
import { ChannelGatewayError, errorText } from './errors.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    channels: ChannelGateway
  }
  interface Events {
    /**
     * One authorized inbound message, normalized. Synchronous broadcast:
     * a listener's returned promise is not awaited, so a listener that needs
     * durable work owns that work itself.
     *
     * That makes this a notification contract, not a delivery guarantee. A
     * consumer that needs durable acceptance registers a sink through
     * {@link ChannelGateway.registerInboundSink}; this event is then announced
     * only after the sink accepted the message.
     */
    'channel/inbound'(message: InboundMessage): void
  }
}

/** How a gateway is built; the plugin row supplies it. */
export interface ChannelGatewayConfig {
  /** The authorization policy. Omitted means an empty allowlist: nobody. */
  readonly auth?: ChannelAuth
}

export class ChannelGateway extends Service {
  private readonly registered = new Map<string, Channel>()
  private readonly auth: ChannelAuth
  /** The one durable acceptance seam, or none while the gateway only announces. */
  private sink: ChannelInboundSink | undefined

  constructor(ctx: Context, config: ChannelGatewayConfig = {}) {
    super(ctx, 'channels')
    this.auth = config.auth ?? allowlistAuth([])
  }

  /**
   * Register the reliable acceptance seam, and return the function that removes
   * it. At most one sink exists at a time: acceptance is a durable commitment,
   * and a second consumer would make "was this message accepted" ambiguous.
   *
   * While a sink is registered, {@link ChannelGateway} awaits
   * `sink.accept(message)` before announcing `channel/inbound`, and a rejection
   * fails the delivering adapter's `deliver` call so it can leave its provider
   * cursor alone and let the provider hand the message over again. The sink is
   * responsible for `(channel, providerMessageId)` deduplication; the gateway
   * stores no business dedupe state.
   */
  registerInboundSink(sink: ChannelInboundSink): () => void {
    if (this.sink !== undefined) {
      throw new ChannelGatewayError('a reliable inbound sink is already registered; unregister it before adding another')
    }
    this.sink = sink
    return () => {
      if (this.sink === sink) this.sink = undefined
    }
  }

  /** Every channel registered right now, in registration order. */
  get channels(): readonly RegisteredChannel[] {
    return [...this.registered.values()].map(channel => ({
      name: channel.name,
      capabilities: channel.capabilities,
    }))
  }

  /**
   * Register one channel and start receiving. The returned function stops it
   * and unregisters it; calling that function twice stops nothing twice.
   *
   * A failed start unregisters the channel and is reported, never left half
   * alive: a channel that cannot receive must not stay addressable for sends.
   */
  register(channel: Channel): () => void {
    if (this.registered.has(channel.name)) {
      throw new ChannelGatewayError(`channel "${channel.name}" is already registered`)
    }
    this.registered.set(channel.name, channel)

    const inbox: ChannelInbox = {
      deliver: async (message) => { await this.accept(channel.name, message) },
    }
    let live = true
    void channel.start(inbox).catch((error: unknown) => {
      if (this.registered.get(channel.name) === channel) this.registered.delete(channel.name)
      this.report('error', `channel "${channel.name}" failed to start: ${errorText(error)}`)
    })

    return () => {
      if (!live) return
      live = false
      this.registered.delete(channel.name)
      void channel.stop().catch((error: unknown) => {
        this.report('error', `channel "${channel.name}" failed to stop: ${errorText(error)}`)
      })
    }
  }

  /**
   * Send one message through the channel it names. A route the channel never
   * minted is that channel's rejection to raise, because only it knows its own
   * address scheme.
   */
  async send(message: OutboundMessage): Promise<ChannelSendResult> {
    const channel = this.registered.get(message.channel)
    if (channel === undefined) {
      throw new ChannelGatewayError(`no channel "${message.channel}" is registered; registered: ${this.names()}`)
    }
    return await channel.send(message)
  }

  /**
   * Fetch the content behind an inbound attachment through the channel that
   * reported it. The channel must be registered and must support attachment
   * download; the gateway carries the bytes back without storing them.
   */
  async resolveAttachment(channel: string, attachment: ChannelAttachment): Promise<ResolvedAttachment> {
    const registered = this.registered.get(channel)
    if (registered === undefined) {
      throw new ChannelGatewayError(`no channel "${channel}" is registered; registered: ${this.names()}`)
    }
    if (registered.resolveAttachment === undefined) {
      throw new ChannelGatewayError(`channel "${channel}" cannot fetch attachment content`)
    }
    return await registered.resolveAttachment(attachment)
  }

  /**
   * Take one message a channel reported: prove it belongs to that channel,
   * authorize it, then hand it to the sink when one is registered and announce
   * it. A message that fails ownership or authorization is dropped here, where
   * the gateway can still see why — a channel never decides who may speak.
   *
   * Dropping a message resolves: refusing it is a decision about that message,
   * and an adapter that re-read it would only be refused again. A sink
   * rejection is the opposite — a transient failure to accept — so it
   * propagates to the adapter, which must then leave its provider cursor where
   * it was and let the provider hand the message over again.
   */
  private async accept(owner: string, message: InboundMessage): Promise<void> {
    if (message.channel !== owner) {
      this.report('error', `channel "${owner}" reported a message for channel "${message.channel}"; dropped`)
      return
    }
    let allowed: boolean
    try {
      allowed = await this.auth.authorize({
        channel: message.channel,
        actor: message.actor,
        place: message.place,
        visibility: message.visibility,
      })
    } catch (error: unknown) {
      this.report('error', `authorization failed for channel "${owner}": ${errorText(error)}; message dropped`)
      return
    }
    if (!allowed) {
      this.report('info', `channel "${owner}" dropped a message from actor "${message.actor.id}": not authorized`)
      return
    }
    // Acceptance precedes the announcement, so a listener never sees a message
    // that is not durable yet.
    const sink = this.sink
    if (sink !== undefined) await sink.accept(message)
    this.ctx.emit('channel/inbound', message)
  }

  private names(): string {
    const names = [...this.registered.keys()]
    return names.length === 0 ? '(none)' : names.join(', ')
  }

  private report(level: 'info' | 'error', message: string): void {
    this.ctx.logger('channel-gateway')[level](message)
  }
}
