/**
 * dsh-channel-gateway: the seam between a chat transport and whatever consumes
 * it.
 *
 * The plugin registers {@link ChannelGateway} as `ctx.channels`. A channel
 * adapter normalizes its provider into {@link InboundMessage}, the gateway
 * authorizes it and announces `channel/inbound`, and a consumer sends through
 * `ctx.channels.send` with a route it saw inbound. Deduplication, session
 * mapping, streaming and agent access are implemented above this layer.
 *
 * Channel adapters live behind their own entries: `./telegram` and `./weixin`.
 * @module @wowyuarm/dsh-channel-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { allowlistAuth } from './auth.ts'
import { ChannelGateway } from './gateway.ts'

export const name = 'dsh-channel-gateway'

/** The gateway plugin row's own configuration: who may speak. */
export interface GatewayPluginConfig {
  /**
   * Authorized actors, as `channel:actorId`; `channel:*` admits one channel's
   * every actor and `*` admits everyone. Default: nobody.
   */
  allow?: string[]
}

export const Config: Schema<GatewayPluginConfig> = Schema.object({
  allow: Schema.array(Schema.string()).default([]),
})

export function apply(ctx: Context, config: GatewayPluginConfig): void {
  ctx.plugin(ChannelGateway, { auth: allowlistAuth(config.allow ?? []) })
}

export * from './contracts.ts'
export * from './auth.ts'
export * from './errors.ts'
export { ChannelGateway } from './gateway.ts'
export type { ChannelGatewayConfig } from './gateway.ts'
