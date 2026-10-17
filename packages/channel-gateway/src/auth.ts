import type { ChannelActor, ChannelPlace, ChannelVisibility } from './contracts.ts'

export interface ChannelAuthRequest {
  readonly channel: string
  readonly actor: ChannelActor
  readonly place: ChannelPlace
  readonly visibility: ChannelVisibility
}

export interface ChannelAuth {
  /** `true` admits the message; a rejection is dropped, never announced. */
  authorize(request: ChannelAuthRequest): boolean | Promise<boolean>
}

/**
 * The default policy: an explicit list of `channel:actorId` entries.
 *
 * `channel:*` admits every actor of one channel, and `*` admits everything.
 * An empty list therefore admits nobody.
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
