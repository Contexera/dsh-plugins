/**
 * What an adapter may say about itself. It is a slice of the host's logger, and
 * it is optional everywhere so a channel can be built and tested without one.
 * @module @wowyuarm/dsh-channel-gateway/adapters/log
 */

/** The two levels a transport loop needs: progress, and a failure worth reading. */
export interface AdapterLog {
  info(message: string): void
  error(message: string): void
}

/** The default: a channel that says nothing. */
export const silentLog: AdapterLog = {
  info: () => {},
  error: () => {},
}
