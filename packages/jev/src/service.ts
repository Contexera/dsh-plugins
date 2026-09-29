/**
 * The Jev service: one evaluation call, its configuration, and the retry policy
 * around it.
 *
 * The service holds no policy of its own. It does not threshold a confidence,
 * gate a decision, choose a posture, or decide that a failure means "quiet": it
 * sends the questions it is given, returns the vendor's answers, and raises a
 * typed {@link JevError} when there are none. A caller that needs a default for
 * a failed judgement is the one that decides what the default is.
 * @module @wowyuarm/dsh-jev/service
 */

import { Service, type Context, type Logger } from '@deepseek-ai/cordis'
import type { JevRequest, JevResult } from './contracts.ts'
import { JevError, errorText, redact, snippet } from './errors.ts'
import { buildWireBody, type JevWireBody } from './request.ts'
import { parseResponse } from './response.ts'
import { fetchTransport, type JevTransport, type JevTransportResponse } from './transport.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jev: Jev
  }
}

/** The vendor's endpoint base: the call goes to this plus {@link SYSTEM_ONE_PATH}. */
export const DEFAULT_API_BASE = 'https://api.typesafe.ai/v1'

/**
 * The model sent unless the deployment configures another one.
 *
 * Pinned to a version rather than an alias on purpose: a threshold is calibrated
 * against one model's answers, so a `latest` alias that moves underneath a
 * deployment would invalidate that calibration without anything failing. The
 * vendor's documentation recommends the same.
 */
export const DEFAULT_MODEL = 'jev-1.13.0'

/** The environment variable the API key is read from unless `apiKeyEnv` names another. */
export const DEFAULT_API_KEY_ENV = 'TYPESAFE_API_KEY'

/** How long one attempt may take before it is abandoned, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** How many attempts one call may take, the first one included. */
export const DEFAULT_ATTEMPTS = 3

/** The wait before the second attempt, in milliseconds; it doubles per further attempt. */
export const DEFAULT_RETRY_DELAY_MS = 500

/** The longest this service waits between attempts, in milliseconds. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

/** The one endpoint this package calls. */
export const SYSTEM_ONE_PATH = '/systemone'

/** How the service is built; the plugin row, or a test, supplies it. */
export interface JevConfig {
  /** Endpoint base — the vendor's own by default, an OpenRouter-style base when that is what the deployment uses. Default {@link DEFAULT_API_BASE}. */
  readonly apiBase?: string
  /** The model id, which the vendor names differently from route to route. Default {@link DEFAULT_MODEL}. */
  readonly model?: string
  /** The API key itself. Prefer `apiKeyEnv`, which keeps the secret out of configuration files. */
  readonly apiKey?: string
  /** The environment variable holding the API key. Default {@link DEFAULT_API_KEY_ENV}. */
  readonly apiKeyEnv?: string
  /** How long one attempt may take, in milliseconds. Default {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** How many attempts one call may take, the first one included. Default {@link DEFAULT_ATTEMPTS}. */
  readonly attempts?: number
  /** The wait before the second attempt, in milliseconds; it doubles per further attempt. Default {@link DEFAULT_RETRY_DELAY_MS}. */
  readonly retryDelayMs?: number
  /** The longest wait between attempts, in milliseconds. Default {@link DEFAULT_MAX_RETRY_DELAY_MS}. */
  readonly maxRetryDelayMs?: number
  /** The HTTP seam. Defaults to the platform `fetch`; a test injects a stub here to run offline. */
  readonly transport?: JevTransport
}

/** Configuration with every default applied and every value checked. */
export interface ResolvedJevConfig {
  /** The absolute endpoint URL. */
  readonly url: string
  /** The model id sent with every call. */
  readonly model: string
  /** The API key, from configuration or the named environment variable. */
  readonly apiKey: string
  /** Per-attempt timeout, in milliseconds. */
  readonly timeoutMs: number
  /** Attempts per call, the first one included. */
  readonly attempts: number
  /** The first backoff, in milliseconds. */
  readonly retryDelayMs: number
  /** The longest wait between attempts, in milliseconds. */
  readonly maxRetryDelayMs: number
  /** The transport every attempt goes through. */
  readonly transport: JevTransport
}

/** One attempt's outcome: the parsed result, or the failure and when to try again. */
type JevAttempt =
  | { readonly ok: true; readonly result: JevResult }
  | { readonly ok: false; readonly error: JevError; readonly retryAfterMs: number | undefined }

/**
 * Apply every default and check every value, so that a deployment with a broken
 * endpoint, model or bound fails where it is configured rather than at the
 * first judgement — which, for a caller like an after-chat pass, means failing
 * once at load instead of silently failing on every turn.
 *
 * @param config — the deployment's configuration; omitted fields take their documented default.
 * @param env — where the API key is read from when `apiKeyEnv` names a variable; defaults to the process environment.
 * @returns the configuration every call is made with.
 * @throws {JevError} `config` when a value is unusable or no API key can be
 * found. The key's value never appears in the message.
 */
export function resolveConfig(
  config: JevConfig = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedJevConfig {
  const apiKeyEnv = readString(config.apiKeyEnv, DEFAULT_API_KEY_ENV, 'apiKeyEnv')
  return {
    url: endpointUrl(config.apiBase),
    model: readString(config.model, DEFAULT_MODEL, 'model'),
    apiKey: readApiKey(config.apiKey, apiKeyEnv, env),
    timeoutMs: readInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs', 1),
    attempts: readInteger(config.attempts, DEFAULT_ATTEMPTS, 'attempts', 1),
    retryDelayMs: readInteger(config.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 'retryDelayMs', 0),
    maxRetryDelayMs: readInteger(config.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS, 'maxRetryDelayMs', 0),
    transport: config.transport ?? fetchTransport,
  }
}

/** Read one configured string, or its default. */
function readString(value: string | undefined, fallback: string, field: string): string {
  const text = value ?? fallback
  if (typeof text !== 'string' || text.trim() === '') {
    throw new JevError('config', `"${field}" must be a non-empty string`)
  }
  return text
}

/** Read one configured whole number, or its default. */
function readInteger(value: number | undefined, fallback: number, field: string, minimum: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum) {
    throw new JevError('config', `"${field}" must be an integer of at least ${minimum}; got ${value}`)
  }
  return value
}

/** Build the absolute endpoint URL from a configured base. */
function endpointUrl(apiBase: string | undefined): string {
  const base = apiBase ?? DEFAULT_API_BASE
  let url: URL
  try {
    url = new URL(base)
  } catch (error: unknown) {
    throw new JevError('config', `"apiBase" must be an absolute URL; got "${base}"`, { cause: error })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new JevError('config', `"apiBase" must be an http or https URL; got "${url.protocol}"`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new JevError('config', `"apiBase" must carry neither a query nor a fragment; got "${base}"`)
  }
  return url.href.replace(/\/+$/u, '') + SYSTEM_ONE_PATH
}

/** Find the API key, or refuse to build a service that could never authenticate. */
function readApiKey(
  apiKey: string | undefined,
  apiKeyEnv: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const key = apiKey === undefined || apiKey === '' ? env[apiKeyEnv] : apiKey
  if (key === undefined || key === '') {
    throw new JevError('config', `no API key: set "apiKey", or put the key in the environment variable "${apiKeyEnv}"`)
  }
  return key
}

/** The Jev service, registered as `ctx.jev` for as long as its plugin is loaded. */
export class Jev extends Service {
  /** The endpoint, model, bounds and transport every call uses. */
  private readonly resolved: ResolvedJevConfig
  /** This service's own log line, for the retries a caller never sees. */
  private readonly log: Logger

  constructor(ctx: Context, config: JevConfig = {}) {
    // Resolved before `super()` on purpose: a configuration failure must not
    // leave a half-built service registered as `ctx.jev` for the moment between
    // the two statements.
    const resolved = resolveConfig(config)
    super(ctx, 'jev')
    this.resolved = resolved
    this.log = ctx.logger('dsh-jev')
  }

  /**
   * Evaluate one set of questions against one state.
   *
   * The call is sent with the configured model. A transport failure, an attempt
   * timeout, or a status the endpoint documents as transient is retried after a
   * backoff, up to the configured attempt count; a `retry-after` the endpoint
   * sent is honored inside `maxRetryDelayMs`. A cancellation is never retried:
   * the caller's decision to stop outranks this service's judgement that a
   * failure was transient.
   *
   * @param request — the state to evaluate and the questions to ask about it.
   * @returns the vendor's result: the model id that answered, one answer per
   * question id, and the usage record when the vendor sent one.
   * @throws {JevError} `request` when the call is malformed (nothing was sent),
   * `http`, `transport`, `timeout` or `protocol` when it failed, or `cancelled`
   * when `request.signal` fired. No failure yields an answer.
   */
  async decide(request: JevRequest): Promise<JevResult> {
    const body = buildWireBody(request, this.resolved.model)
    const headers = {
      authorization: `Bearer ${this.resolved.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    }

    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.send(body, headers, request.signal)
      if (outcome.ok) return outcome.result
      if (!isRetryable(outcome.error) || attempt >= this.resolved.attempts) throw outcome.error

      const delay = this.nextDelay(attempt, outcome.retryAfterMs)
      if (delay === undefined) {
        this.log.warn(`no retry: the endpoint asked for ${outcome.retryAfterMs}ms, past maxRetryDelayMs (${this.resolved.maxRetryDelayMs}ms)`)
        throw outcome.error
      }
      this.log.warn(`attempt ${attempt}/${this.resolved.attempts} failed (${outcome.error.kind}): ${outcome.error.message}; retrying in ${delay}ms`)
      await sleep(delay, request.signal)
    }
  }

  /**
   * How long to wait before the next attempt, or `undefined` when waiting is
   * pointless.
   *
   * A `retry-after` from the endpoint outranks this service's own backoff:
   * trying again earlier than it asked would only collect another rejection.
   * It does not outrank `maxRetryDelayMs`, which is the longest a caller agreed
   * to wait — a longer one stops the call instead of blocking past the bound.
   */
  private nextDelay(attempt: number, retryAfterMs: number | undefined): number | undefined {
    const backoff = Math.min(this.resolved.maxRetryDelayMs, this.resolved.retryDelayMs * 2 ** (attempt - 1))
    if (retryAfterMs === undefined) return backoff
    if (retryAfterMs > this.resolved.maxRetryDelayMs) return undefined
    return Math.max(backoff, retryAfterMs)
  }

  /**
   * Send one attempt: compose the caller's cancellation with this attempt's own
   * timeout, then classify what came back.
   *
   * Classification is by this service's own flags rather than by the abort
   * reason, so a cancellation is never mistaken for a timeout: the two differ in
   * whether another attempt may happen at all.
   */
  private async send(
    body: JevWireBody,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
  ): Promise<JevAttempt> {
    const controller = new AbortController()
    let timedOut = false
    let cancelled = false
    const cancel = (): void => {
      cancelled = true
      controller.abort()
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted === true) cancel()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.resolved.timeoutMs)

    let response: JevTransportResponse
    try {
      response = await this.resolved.transport({
        url: this.resolved.url,
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error: unknown) {
      return { ok: false, error: this.transportFailure(error, cancelled, timedOut), retryAfterMs: undefined }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }

    if (response.status < 200 || response.status >= 300) {
      const error = new JevError('http', `the endpoint answered ${response.status}: ${this.redacted(snippet(response.body))}`, {
        status: response.status,
      })
      return { ok: false, error, retryAfterMs: parseRetryAfter(response.headers['retry-after'], Date.now()) }
    }

    try {
      return { ok: true, result: parseResponse(response.body, body.questions, text => this.redacted(text)) }
    } catch (error: unknown) {
      // Only this package's own failures are classified here; anything else is a
      // bug in the parser and must not be reported as a vendor problem.
      if (!(error instanceof JevError)) throw error
      return { ok: false, error, retryAfterMs: undefined }
    }
  }

  /** Name what went wrong on an attempt that never produced a response. */
  private transportFailure(error: unknown, cancelled: boolean, timedOut: boolean): JevError {
    if (cancelled) return new JevError('cancelled', 'the call was cancelled', { cause: error })
    if (timedOut) {
      return new JevError('timeout', `no response within ${this.resolved.timeoutMs}ms`, { cause: error })
    }
    return new JevError('transport', `the request failed: ${this.redacted(errorText(error))}`, { cause: error })
  }

  /** Redact the key from any text this service puts into a message or a log. */
  private redacted(text: string): string {
    return redact(text, [this.resolved.apiKey])
  }
}

/** Whether another attempt could succeed. A cancellation is a decision, not a failure to retry. */
function isRetryable(error: JevError): boolean {
  switch (error.kind) {
    case 'transport':
    case 'timeout':
      return true
    case 'http':
      // 408 and 429 are the endpoint asking for another attempt; 5xx is the
      // endpoint failing at its own job. Every other status is this caller's
      // mistake, and repeating it would only repeat the rejection.
      return error.status !== undefined && (error.status === 408 || error.status === 429 || error.status >= 500)
    case 'config':
    case 'request':
    case 'protocol':
    case 'cancelled':
      return false
  }
}

/**
 * The wait the endpoint asked for, in milliseconds.
 *
 * Both documented forms are accepted — a whole number of seconds, or an HTTP
 * date — and an absent or unreadable header yields `undefined`, because a header
 * this package cannot parse is no reason to drop a call that could still
 * succeed.
 *
 * @param value — the `retry-after` header, whose name the transport lowercased.
 * @param now — the current epoch time in milliseconds, passed in so the date form is testable.
 * @returns the wait, or `undefined` when the header says nothing usable.
 */
function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

/**
 * Wait out one backoff, unless the caller cancels first.
 *
 * The timer is local rather than `ctx.timeout`: that helper belongs to a timer
 * plugin this package does not declare, and a provider that reaches for a
 * service it never declared is not installable on its own.
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise(resolve => { setTimeout(resolve, ms) })
  const abortSignal = signal
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    function cleanup(): void {
      clearTimeout(timer)
      abortSignal.removeEventListener('abort', onAbort)
    }
    function onAbort(): void {
      cleanup()
      reject(new JevError('cancelled', 'the call was cancelled while waiting to retry it'))
    }
    abortSignal.addEventListener('abort', onAbort, { once: true })
    if (abortSignal.aborted) onAbort()
  })
}
