/**
 * The one error type the gateway raises for a caller's mistake, plus the
 * message extraction every adapter needs when it reports a failure.
 * @module @wowyuarm/dsh-channel-gateway/errors
 */

/**
 * A rejected gateway operation: an unknown or duplicate channel, a route the
 * named channel never minted, or a message the channel cannot carry. It is the
 * caller's mistake, not a transport failure, and the message says which.
 */
export class ChannelGatewayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelGatewayError'
  }
}

/** One line of text for any thrown value, so a log line never reads `[object Object]`. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}
