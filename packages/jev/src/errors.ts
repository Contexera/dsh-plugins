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

export interface JevErrorOptions {
  /** HTTP status, on an `http` failure. */
  readonly status?: number | undefined
  readonly cause?: unknown
}

/**
 * A Jev failure. Every failure path raises one of these and no other type, so a
 * consumer can branch on {@link JevErrorKind} instead of matching message text.
 */
export class JevError extends Error {
  readonly kind: JevErrorKind
  readonly status: number | undefined

  constructor(kind: JevErrorKind, message: string, options: JevErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JevError'
    this.kind = kind
    this.status = options.status
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

const SNIPPET_LENGTH = 200

export function snippet(body: string): string {
  return body.length <= SNIPPET_LENGTH ? body : `${body.slice(0, SNIPPET_LENGTH)}...`
}

export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret === undefined || secret === '') continue
    result = result.split(secret).join('[redacted]')
  }
  return result
}
