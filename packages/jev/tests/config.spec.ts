import { describe, expect, it } from 'vitest'
import { JevError } from '../src/errors.ts'
import {
  DEFAULT_API_BASE,
  DEFAULT_API_KEY_ENV,
  DEFAULT_ATTEMPTS,
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_MODEL,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
} from '../src/service.ts'
import { fetchTransport } from '../src/transport.ts'

/** Run a resolution and return the failure it raised. */
function failure(run: () => unknown): JevError {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof JevError) return error
    throw error
  }
  throw new Error('expected the configuration to be rejected')
}

describe('resolveConfig', () => {
  it('defaults to the vendor\'s endpoint, the pinned model, and the documented bounds', () => {
    const resolved = resolveConfig({}, { [DEFAULT_API_KEY_ENV]: 'k' })

    expect(resolved.url).toBe(`${DEFAULT_API_BASE}/systemone`)
    expect(resolved.model).toBe(DEFAULT_MODEL)
    expect(resolved.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(resolved.attempts).toBe(DEFAULT_ATTEMPTS)
    expect(resolved.retryDelayMs).toBe(DEFAULT_RETRY_DELAY_MS)
    expect(resolved.maxRetryDelayMs).toBe(DEFAULT_MAX_RETRY_DELAY_MS)
    expect(resolved.transport).toBe(fetchTransport)
  })

  it('reads the key from the environment variable the deployment named', () => {
    const resolved = resolveConfig({ apiKeyEnv: 'JEV_TEST_KEY' }, { JEV_TEST_KEY: 'from-env' })

    expect(resolved.apiKey).toBe('from-env')
    expect(resolveConfig({}, { [DEFAULT_API_KEY_ENV]: 'from-default-env' }).apiKey).toBe('from-default-env')
  })

  it('prefers a configured key over the environment', () => {
    expect(resolveConfig({ apiKey: 'configured', apiKeyEnv: 'JEV_TEST_KEY' }, { JEV_TEST_KEY: 'from-env' }).apiKey)
      .toBe('configured')
  })

  it('refuses to build without a key, naming where it looked and never the key', () => {
    const error = failure(() => resolveConfig({ apiKeyEnv: 'JEV_TEST_KEY_ABSENT' }, {}))

    expect(error.kind).toBe('config')
    expect(error.message).toContain('no API key')
    expect(error.message).toContain('JEV_TEST_KEY_ABSENT')
  })

  it('treats an empty key as no key', () => {
    expect(failure(() => resolveConfig({ apiKey: '', apiKeyEnv: 'JEV_TEST_KEY_ABSENT' }, {})).kind).toBe('config')
  })

  it('joins the endpoint path without doubling the slash of a base that ends in one', () => {
    expect(resolveConfig({ apiBase: 'https://api.typesafe.ai/v1/' }, { [DEFAULT_API_KEY_ENV]: 'k' }).url)
      .toBe('https://api.typesafe.ai/v1/systemone')
  })

  it('rejects an endpoint base that is not an absolute http or https URL', () => {
    expect(failure(() => resolveConfig({ apiBase: '/v1', apiKey: 'k' }, {})).message).toContain('"apiBase" must be an absolute URL')
    expect(failure(() => resolveConfig({ apiBase: 'ftp://host/v1', apiKey: 'k' }, {})).message).toContain('must be an http or https URL')
    expect(failure(() => resolveConfig({ apiBase: 'https://host/v1?x=1', apiKey: 'k' }, {})).message).toContain('neither a query nor a fragment')
  })

  it('rejects a bound that is not a whole number, and accepts a zero backoff', () => {
    expect(failure(() => resolveConfig({ timeoutMs: 0, apiKey: 'k' }, {})).message).toContain('"timeoutMs" must be an integer of at least 1')
    expect(failure(() => resolveConfig({ attempts: 1.5, apiKey: 'k' }, {})).message).toContain('"attempts" must be an integer of at least 1')
    expect(failure(() => resolveConfig({ retryDelayMs: -1, apiKey: 'k' }, {})).message).toContain('"retryDelayMs" must be an integer of at least 0')
    expect(resolveConfig({ retryDelayMs: 0, apiKey: 'k' }, {}).retryDelayMs).toBe(0)
  })

  it('rejects an empty model or key variable name, which could never identify anything', () => {
    expect(failure(() => resolveConfig({ model: ' ', apiKey: 'k' }, {})).message).toContain('"model" must be a non-empty string')
    expect(failure(() => resolveConfig({ apiKeyEnv: '', apiKey: 'k' }, {})).message).toContain('"apiKeyEnv" must be a non-empty string')
  })
})
