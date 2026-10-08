/**
 * The one error type this package raises, and the redaction every message goes
 * through on the way out.
 * @module @contexera/dsh-jev/errors
 */

/**
 * What a caller can do about the failure, which is the only thing the kind is
 * for:
 *
 * - `config` — the deployment is wrong; no call can succeed until it is fixed.
 * - `request` — this call's arguments are malformed; nothing was sent.
 * - `transport` — the network or TLS failed.
 * - `timeout` — no answer arrived within the attempt's timeout.
 * - `http` — the endpoint answered with a non-2xx status.
 * - `protocol` — a 2xx body that is not the documented response. Unlike the
 *   kinds above, this one can mean the vendor changed shape underneath us.
 * - `cancelled` — the caller aborted.
 */
export type JevErrorKind = 'config' | 'request' | 'transport' | 'timeout' | 'http' | 'protocol' | 'cancelled'

/** Options a failure carries beyond its message. */
export interface JevErrorOptions {
  /** HTTP status, on an `http` failure. */
  readonly status?: number | undefined
  /** The underlying throwable, when there was one. */
  readonly cause?: unknown
}

/**
 * A Jev failure. Every failure path raises one of these and no other type, so a
 * consumer can branch on {@link JevErrorKind} instead of matching message text.
 *
 * A failed call never fabricates an answer: deciding that a failure means
 * "quiet" is a consumer's policy, and the provider does not hold one.
 */
export class JevError extends Error {
  /** What the caller can do about it. */
  readonly kind: JevErrorKind
  /** HTTP status, when the failure came from a response. */
  readonly status: number | undefined

  constructor(kind: JevErrorKind, message: string, options: JevErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JevError'
    this.kind = kind
    this.status = options.status
  }
}

/** One line of text for any thrown value, so a message never reads `[object Object]`. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** How much of a body an error message may carry. */
const SNIPPET_LENGTH = 200

/**
 * One bounded excerpt of a body, for a message that would otherwise only say
 * that something was wrong with it. Bounded on purpose: an error message is not
 * a place to paste a response.
 *
 * @param body — the body to excerpt.
 * @returns the body, or its first {@link SNIPPET_LENGTH} characters followed by `...`.
 */
export function snippet(body: string): string {
  return body.length <= SNIPPET_LENGTH ? body : `${body.slice(0, SNIPPET_LENGTH)}...`
}

/**
 * Replace every occurrence of a secret with a marker. Applied to anything that
 * leaves this package inside an error message — a transport message or a
 * response body could carry the credential back, and a key that reaches a log
 * is a key that has to be rotated.
 */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret === undefined || secret === '') continue
    result = result.split(secret).join('[redacted]')
  }
  return result
}
