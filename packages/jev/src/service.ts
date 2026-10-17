/**
 * The Jev service: one evaluation call, its configuration, and the retry policy
 * around it.
 * @module @contexera/dsh-jev/service
 */

import { Service, type Context, type Logger } from '@deepseek-ai/cordis'
import type { JevRequest, JevResult } from './contracts.ts'
import { JevError, errorText, redact, snippet } from './errors.ts'
import { buildWireBody, serializeWireBody, type JevWireQuestion } from './request.ts'
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

export const DEFAULT_TIMEOUT_MS = 30_000

/** How many attempts one call may take, the first one included. */
export const DEFAULT_ATTEMPTS = 3

/** The wait before the second attempt, in milliseconds; it doubles per further attempt. */
export const DEFAULT_RETRY_DELAY_MS = 500

export const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

export const SYSTEM_ONE_PATH = '/systemone'

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
  readonly model: string
  /** The API key, from configuration or the named environment variable. */
  readonly apiKey: string
  /** Per-attempt timeout, in milliseconds. */
  readonly timeoutMs: number
  /** Attempts per call, the first one included. */
  readonly attempts: number
  /** The first backoff, in milliseconds. */
  readonly retryDelayMs: number
  readonly maxRetryDelayMs: number
  readonly transport: JevTransport
}

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

function readString(value: string | undefined, fallback: string, field: string): string {
  const text = value ?? fallback
  if (typeof text !== 'string' || text.trim() === '') {
    throw new JevError('config', `"${field}" must be a non-empty string`)
  }
  return text
}

function readInteger(value: number | undefined, fallback: number, field: string, minimum: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum) {
    throw new JevError('config', `"${field}" must be an integer of at least ${minimum}; got ${value}`)
  }
  return value
}

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
  private readonly resolved: ResolvedJevConfig
  private readonly log: Logger

  constructor(ctx: Context, config: JevConfig = {}) {
    const resolved = resolveConfig(config)
    super(ctx, 'jev')
    this.resolved = resolved
    this.log = ctx.logger('dsh-jev')
  }

  /**
   * Evaluate one set of questions against one state.
   *
   * A transport failure, an attempt timeout, or a status the endpoint documents
   * as transient is retried after a backoff, up to the configured attempt count;
   * a `retry-after` the endpoint sent is honored inside `maxRetryDelayMs`. A
   * cancellation is never retried.
   *
   * @throws {JevError} `request` when the call is malformed or cannot be
   * serialized (nothing was sent), `http`, `transport`, `timeout` or `protocol`
   * when it failed, or `cancelled` when `request.signal` fired.
   */
  async decide(request: JevRequest): Promise<JevResult> {
    const wire = buildWireBody(request, this.resolved.model)
    const body = serializeWireBody(wire)
    const headers = {
      authorization: `Bearer ${this.resolved.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    }

    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.send(body, wire.questions, headers, request.signal)
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

  private nextDelay(attempt: number, retryAfterMs: number | undefined): number | undefined {
    const backoff = Math.min(this.resolved.maxRetryDelayMs, this.resolved.retryDelayMs * 2 ** (attempt - 1))
    if (retryAfterMs === undefined) return backoff
    if (retryAfterMs > this.resolved.maxRetryDelayMs) return undefined
    return Math.max(backoff, retryAfterMs)
  }

  private async send(
    body: string,
    questions: Readonly<Record<string, JevWireQuestion>>,
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
        body,
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
      return { ok: true, result: parseResponse(response.body, questions, text => this.redacted(text)) }
    } catch (error: unknown) {
      if (!(error instanceof JevError)) throw error
      return { ok: false, error, retryAfterMs: undefined }
    }
  }

  private transportFailure(error: unknown, cancelled: boolean, timedOut: boolean): JevError {
    if (cancelled) return new JevError('cancelled', 'the call was cancelled', { cause: error })
    if (timedOut) {
      return new JevError('timeout', `no response within ${this.resolved.timeoutMs}ms`, { cause: error })
    }
    return new JevError('transport', `the request failed: ${this.redacted(errorText(error))}`, { cause: error })
  }

  private redacted(text: string): string {
    return redact(text, [this.resolved.apiKey])
  }
}

function isRetryable(error: JevError): boolean {
  switch (error.kind) {
    case 'transport':
    case 'timeout':
      return true
    case 'http':
      return error.status !== undefined && (error.status === 408 || error.status === 429 || error.status >= 500)
    case 'config':
    case 'request':
    case 'protocol':
    case 'cancelled':
      return false
  }
}

function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

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
