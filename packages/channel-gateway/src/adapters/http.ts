/**
 * The two transport facts every polling adapter shares: which fetch to use, and
 * how to wait without outliving a stop.
 * @module @wowyuarm/dsh-channel-gateway/adapters/http
 */

import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

/** The proxy variables Node's own fetch does not read on its own. */
function proxyUrl(): string | undefined {
  const raw = process.env.HTTPS_PROXY
    ?? process.env.HTTP_PROXY
    ?? process.env.https_proxy
    ?? process.env.http_proxy
  return raw === undefined || raw === '' ? undefined : raw
}

/**
 * A fetch that honours `HTTPS_PROXY`/`NO_PROXY` and otherwise is the global one.
 *
 * Node's global fetch ignores the proxy variables unless `NODE_USE_ENV_PROXY`
 * is set, and a bot API that is only reachable through a proxy is a transport
 * fact rather than a usage choice — the transport layer is the right place for
 * it, and every layer above keeps calling a plain fetch.
 */
export function proxyAwareFetch(): typeof fetch {
  if (proxyUrl() === undefined) return globalThis.fetch
  const agent = new EnvHttpProxyAgent()
  const proxied = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    })
  return proxied as unknown as typeof fetch
}

/** Wait `ms`, or give up as soon as `signal` aborts. Never rejects. */
export function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise(resolve => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** How a send decides whether a failure is worth trying again, and how long to wait. */
export interface RetryPolicy {
  /** Attempts after the first, e.g. 3 means up to four calls in all. */
  readonly retries: number
  /** First backoff; doubled each further attempt. */
  readonly baseDelayMs: number
  /** Whether this error is transient rather than a rejection the provider means. */
  isRetryable(error: unknown): boolean
  /** A provider-dictated wait (Telegram's `retry_after`), preferred over backoff. */
  retryAfterMs?(error: unknown): number | undefined
  /** Reported once per retry, so a wedged provider is visible in the log. */
  onRetry?(error: unknown, waitMs: number): void
}

/**
 * Run `operation`, retrying transient failures with exponential backoff. Only
 * sends use this: a failed send otherwise loses a reply to a network blip or a
 * rate limit, while polling has its own loop. A non-retryable error, or the
 * last attempt's error, is rethrown unchanged.
 */
export async function withRetry<T>(operation: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error: unknown) {
      if (attempt >= policy.retries || !policy.isRetryable(error)) throw error
      const waitMs = policy.retryAfterMs?.(error) ?? policy.baseDelayMs * 2 ** attempt
      policy.onRetry?.(error, waitMs)
      await delay(waitMs, undefined)
    }
  }
}
