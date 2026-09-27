/**
 * The gateway service: register channels, authorize inbound, announce
 * `channel/inbound`, send outbound.
 *
 * It does not interpret messages: what a message means, where it goes next and
 * whether it was seen before are decided by whoever listens to the event or
 * calls {@link ChannelGateway.send}.
 * @module @wowyuarm/dsh-channel-gateway/gateway
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { allowlistAuth, type ChannelAuth } from './auth.ts'
import type {
  Channel,
  ChannelAttachment,
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

  constructor(ctx: Context, config: ChannelGatewayConfig = {}) {
    super(ctx, 'channels')
    this.auth = config.auth ?? allowlistAuth([])
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
      deliver: (message) => { void this.accept(channel.name, message) },
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
   * authorize it, then announce it. A message that fails either step is
   * dropped here, where the gateway can still see why — a channel never
   * decides who may speak.
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
