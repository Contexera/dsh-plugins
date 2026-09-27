/**
 * Authorization at the transport boundary: one question, asked before any
 * inbound message is announced.
 *
 * The gateway asks it and the channel never sees the answer, so a transport
 * cannot decide who may speak. The policy is an interface rather than a
 * configuration shape because pairing, OAuth, or a per-channel rule can arrive
 * later without changing the gateway core.
 * @module @wowyuarm/dsh-channel-gateway/auth
 */

import type { ChannelActor, ChannelPlace, ChannelVisibility } from './contracts.ts'

/** Everything a policy may decide on: who spoke, where, and in front of whom. */
export interface ChannelAuthRequest {
  readonly channel: string
  readonly actor: ChannelActor
  readonly place: ChannelPlace
  readonly visibility: ChannelVisibility
}

/** Decide whether one inbound message may enter the Harness at all. */
export interface ChannelAuth {
  /** `true` admits the message; a rejection is dropped, never announced. */
  authorize(request: ChannelAuthRequest): boolean | Promise<boolean>
}

/**
 * The default policy: an explicit list of `channel:actorId` entries.
 *
 * `channel:*` admits every actor of one channel, and `*` admits everything —
 * both spelled out, because a gateway that does not know who may speak stays
 * silent rather than guessing. An empty list therefore admits nobody.
 */
export function allowlistAuth(entries: readonly string[]): ChannelAuth {
  const allowed = new Set(entries.map(entry => entry.trim()).filter(entry => entry !== ''))
  return {
    authorize({ channel, actor }) {
      return allowed.has('*')
        || allowed.has(`${channel}:*`)
        || allowed.has(`${channel}:${actor.id}`)
    },
  }
}
