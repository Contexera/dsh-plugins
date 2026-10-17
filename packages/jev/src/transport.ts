/**
 * The one HTTP seam this package has, and the default implementation of it.
 * @module @contexera/dsh-jev/transport
 */

export interface JevTransportRequest {
  /** The absolute endpoint URL. */
  readonly url: string
  /** Request headers, already carrying the credential. */
  readonly headers: Readonly<Record<string, string>>
  /** The serialized request body. */
  readonly body: string
  /**
   * Aborts this attempt — on the caller's cancellation, or on the attempt's own
   * timeout. The service composes the two, so a transport never needs a timeout
   * of its own.
   */
  readonly signal: AbortSignal
}

export interface JevTransportResponse {
  readonly status: number
  /** Response headers, lowercased, so a lookup does not depend on the wire's casing. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/**
 * Sends one attempt. Rejects on a transport failure — a network or TLS error,
 * or the abort signal firing; a non-2xx status is a resolved response, because
 * only the service decides what a status means.
 */
export type JevTransport = (request: JevTransportRequest) => Promise<JevTransportResponse>

export const fetchTransport: JevTransport = async (request) => {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  })
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })
  return { status: response.status, headers, body: await response.text() }
}
